import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildTaisceSessionDeps, chatGenerate } from "../../src/commands/chat.ts";
import { PRIVACY_CHECK_LINE } from "../../src/lib/taisce/skills.ts";

// A fake Taisce checkout, so the real ~/context-workspace is never read or touched by a test.
const root = mkdtempSync(join(tmpdir(), "moss-session-wiring-"));
function put(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}
const skill = (d: string) => `---\nname: x\ndescription: >\n  ${d}\n---\n\n# body of ${d}\n`;
put(".claude/skills/standup/SKILL.md", skill("Standup — the brief."));
put(".claude/skills/capture/SKILL.md", skill("Capture a fact."));
put(".claude/skills/repo-audit/SKILL.md", skill("Audit."));
put(".claude/settings.json", JSON.stringify({ skillOverrides: { "repo-audit": "name-only" } }));
put("Library/skills/standup/SKILL.md", skill("Standup — the brief."));
put("Library/skills/capture/SKILL.md", skill("Capture a fact."));
put("System/04-privacy-and-sensitivity-rules.md", "# Rules\n\nRaw balances stay local.\n");
put("System/pulse.md", "PULSE TABLE\n");
put("Sources/Health/vitals.md", "never read");
put("Projects/home-reset/plan.md", "never read");
const missing = join(root, "does-not-exist");

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("buildTaisceSessionDeps — the session wired to a Taisce checkout", () => {
  const deps = buildTaisceSessionDeps(root);

  it("prepends the real privacy rules file", () => {
    expect(deps.guardrails?.()).toContain("Raw balances stay local.");
  });

  it("offers only the live skills", () => {
    expect(deps.skills?.().map((s) => s.id)).toEqual(["capture", "standup"]);
  });

  it("builds /standup with its Pulse input, and asks the privacy question", () => {
    const built = deps.skillPrompt?.("standup", "");
    expect(built?.id).toBe("standup");
    expect(built?.loaded).toEqual(["Library/skills/standup/SKILL.md", "System/pulse.md"]);
    expect(built?.body).toContain("PULSE TABLE");
    expect(built?.body).toContain(PRIVACY_CHECK_LINE);
    // The rules ride in the system prompt, so they are not repeated in the body.
    expect(built?.body).not.toContain("Raw balances stay local.");
  });

  it("builds /capture from what was typed", () => {
    expect(deps.skillPrompt?.("capture", "paid the gas bill")?.body).toContain("paid the gas bill");
    expect(() => deps.skillPrompt?.("nope", "")).toThrow("no Taisce skill");
  });

  it("/read goes through guard-reads", () => {
    expect(deps.readFile?.("System/pulse.md")).toBe("PULSE TABLE\n");
    expect(() => deps.readFile?.("Sources/Health/vitals.md")).toThrow("guard-reads");
  });

  it("/edit inside Taisce refuses a gated file; outside Taisce it does not apply", () => {
    expect(() => deps.edit?.checkFiles(root, ["Projects/home-reset/plan.md"])).toThrow(
      "guard-reads",
    );
    expect(() => deps.edit?.checkFiles(root, ["System/pulse.md"])).not.toThrow();
    expect(() => deps.edit?.checkFiles(tmpdir(), ["Projects/home-reset/plan.md"])).not.toThrow();
  });

  it("wires the coder model, the plan helpers and the reasoning-model check", () => {
    expect(deps.edit?.coderModel()).toBeTruthy();
    expect(deps.edit?.pickFiles("edit a.ts", ["a.ts", "b.ts"])).toEqual(["a.ts"]);
    expect(deps.edit?.parsePlan("FILES: a.ts\nPLAN: do").plan).toBe("do");
    expect(deps.edit?.buildPlanPrompt("x", ["a.ts"])).toContain("REQUEST: x");
    expect(() => deps.checkModel?.("qwen3:4b")).toThrow("reasoning model");
    expect(deps.numCtx).toBeGreaterThanOrEqual(2048);
  });

  it("degrades to nothing when there is no Taisce checkout", async () => {
    const none = buildTaisceSessionDeps(missing);
    expect(none.guardrails?.()).toBeNull();
    expect(none.skills?.()).toEqual([]);
    expect(await none.brief?.()).toBeNull();
    expect(await none.frontDoor?.("my runway")).toBeNull();
  });
});

describe("chatGenerate", () => {
  it("refuses a reasoning model before anything is sent", async () => {
    const result = await chatGenerate({ prompt: "hi", model: "qwen3:4b" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("reasoning model");
  });
});
