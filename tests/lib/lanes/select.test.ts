import { describe, expect, it } from "vitest";
import { renderLaneChoice } from "../../../src/lib/lanes/explain.ts";
import { selectLane } from "../../../src/lib/lanes/select.ts";
import { lanes, PULLED_WITH_GEMMA, policy, policyApiOn } from "./fixtures.ts";

const input = { promptTokens: 3000 } as const;

describe("selectLane", () => {
  it("a local task never probes a Claude lane", async () => {
    const deps = lanes({ ollama: "available", "claude-code": "available" });
    const choice = await selectLane(policy, { ...input, task: "brief" }, deps);
    expect(choice).toMatchObject({ lane: "ollama", model: "llama3.1:latest", stageOnly: false });
    expect(deps.probed).toEqual(["ollama"]);
  });

  it("reason takes the subscription first, Sonnet first, and stops probing at the pick", async () => {
    const deps = lanes({
      "claude-code": "available",
      "anthropic-api": "available",
      ollama: "available",
    });
    const choice = await selectLane(policy, { ...input, task: "reason" }, deps);
    expect(choice).toMatchObject({ lane: "claude-code", model: "sonnet" });
    expect(deps.probed).toEqual(["claude-code"]);
    expect(choice.estimate?.usd).toBeCloseTo((3000 * 2 + 2048 * 10) / 1e6);
  });

  it("logged out → API under the cap; over the cap → refused, falls to local, and says why", async () => {
    const api = await selectLane(
      policyApiOn,
      { ...input, task: "reason" },
      lanes(
        {
          "claude-code": "unauthenticated",
          "anthropic-api": "available",
          ollama: "available",
        },
        PULLED_WITH_GEMMA,
      ),
    );
    expect(api.lane).toBe("anthropic-api");
    expect(api.estimate?.eur).toBeGreaterThan(0);
    const over = await selectLane(
      policyApiOn,
      { ...input, task: "reason" },
      lanes(
        { "claude-code": "unauthenticated", "anthropic-api": "available", ollama: "available" },
        PULLED_WITH_GEMMA,
        1.99,
      ),
    );
    expect(over.lane).toBe("ollama");
    const refusal = over.verdicts.find((v) => v.lane === "anthropic-api");
    expect(refusal?.reason).toMatch(
      /^refused: over the daily cap — €1\.99 spent today \+ up to €0\.\d\d for this call > €2\.00/,
    );
  });

  it("a gate forces the best available lane of all, even for a local task, and is stage-only", async () => {
    const choice = await selectLane(
      policy,
      { ...input, task: "route", gates: ["irreversible"] },
      lanes({ "claude-code": "available", ollama: "available" }),
    );
    expect(choice).toMatchObject({
      lane: "claude-code",
      model: "sonnet",
      stageOnly: true,
      gates: ["irreversible"],
    });
    const local = await selectLane(
      policy,
      { ...input, task: "brief", gates: ["external-facing"] },
      lanes({ ollama: "available" }),
    );
    expect(local).toMatchObject({ lane: "ollama", stageOnly: true });
    expect(renderLaneChoice(local, "h")).toContain("STAGE-ONLY");
  });

  it("an unpulled local model is skipped with the pull command, never pulled", async () => {
    const choice = await selectLane(
      policy,
      { ...input, task: "vision" },
      lanes({ ollama: "available" }),
    );
    expect(choice.lane).toBeNull();
    expect(choice.verdicts[0]?.reason).toContain("`ollama pull gemma4:12b`");
    expect(renderLaneChoice(choice, "h")).toContain("NONE");
  });

  it("a pin wins: opus on claude-code, or a named local model", async () => {
    const opus = await selectLane(
      policy,
      { ...input, task: "reason", pinLane: "claude-code", pinModel: "opus" },
      lanes({ "claude-code": "available" }),
    );
    expect(opus).toMatchObject({ lane: "claude-code", model: "opus" });
    expect(opus.verdicts[0]?.reason).toContain("pinned");
    const local = await selectLane(
      policy,
      { ...input, task: "reason", pinLane: "ollama", pinModel: "qwen2.5:3b-instruct" },
      lanes({ ollama: "available" }),
    );
    expect(local.model).toBe("qwen2.5:3b-instruct");
  });

  it("skips a lane that cannot do the task or has no settings for it", async () => {
    const choice = await selectLane(
      policy,
      { ...input, task: "vision", pinLane: "claude-code" },
      lanes({ "claude-code": "available" }),
    );
    expect(choice.verdicts[0]?.reason).toBe("cannot do 'vision'.");
    const litellm = await selectLane(
      policy,
      { ...input, task: "brief", pinLane: "litellm" },
      lanes({ litellm: "available" }),
    );
    expect(litellm.verdicts[0]?.reason).toContain("routing.yaml gives it no model");
  });
});

describe("the metered lane is off unless routing.yaml turns it on", () => {
  it("skips anthropic-api before probing it, even with a key present", async () => {
    const deps = lanes(
      {
        "claude-code": "unauthenticated",
        "anthropic-api": "available",
        ollama: "available",
      },
      PULLED_WITH_GEMMA,
    );
    const choice = await selectLane(policy, { ...input, task: "reason" }, deps);
    expect(choice.lane).toBe("ollama");
    expect(choice.verdicts.find((v) => v.lane === "anthropic-api")?.reason).toContain(
      "switched off in routing.yaml (caps.anthropic-api.enabled: false)",
    );
    expect(deps.probed).not.toContain("anthropic-api");
    expect(policy.caps["anthropic-api"].enabled).toBe(false);
  });
});

describe("renderLaneChoice", () => {
  it("prints lane, model, every verdict, and the cost by billing", async () => {
    const choice = await selectLane(
      policyApiOn,
      { ...input, task: "reason" },
      lanes({ "claude-code": "unauthenticated", "anthropic-api": "available" }),
    );
    const text = renderLaneChoice(
      choice,
      "moss run council — route",
      "Taisce skill 'expert-council'",
    );
    expect(text).toContain("lane:   anthropic-api · sonnet");
    expect(text).toContain("· skipped claude-code — claude-code is unauthenticated.");
    expect(text).toContain("✓ picked  anthropic-api");
    expect(text).toContain("metered, counts toward the daily cap");
    const sub = await selectLane(
      policyApiOn,
      { ...input, task: "edit" },
      lanes({ "claude-code": "available" }),
    );
    expect(renderLaneChoice(sub, "h")).toContain("subscription (no per-call bill");
    const local = await selectLane(
      policyApiOn,
      { ...input, task: "edit" },
      lanes({ ollama: "available" }),
    );
    expect(renderLaneChoice(local, "h")).toContain("(editor qwen2.5-coder:7b)");
    expect(renderLaneChoice(local, "h")).toContain("€0 (local)");
  });
});
