// AI tools: the Claude CLI against its published version, Ollama, the models routing.yaml
// needs, the last bench, and which lanes are up.
import { lastBench } from "../bench.ts";
import type { RoutingPolicy } from "../lanes/policy.ts";
import { LANE_TASK_TYPES } from "../providers/metadata.ts";
import { ageDays, type Check, type CheckResult } from "./types.ts";

const G = "AI tools";

export const claudeCli: Check = {
  group: G,
  name: "Claude Code CLI",
  run: async (ctx) => {
    const [have, latest] = await Promise.all([
      ctx.run("claude", ["--version"], 20_000),
      ctx.run("npm", ["view", "@anthropic-ai/claude-code", "version"], 30_000),
    ]);
    const v = /(\d+\.\d+\.\d+)/.exec(have.stdout)?.[1];
    const l = /(\d+\.\d+\.\d+)/.exec(latest.stdout)?.[1];
    if (v === undefined)
      return {
        group: G,
        name: "Claude Code CLI",
        status: "WARN",
        detail: "claude not found",
        fix: "npm install -g @anthropic-ai/claude-code",
      };
    if (l === undefined)
      return {
        group: G,
        name: "Claude Code CLI",
        status: "PASS",
        detail: `${v} (could not reach npm for the latest)`,
      };
    return v === l
      ? { group: G, name: "Claude Code CLI", status: "PASS", detail: `${v}, the latest` }
      : {
          group: G,
          name: "Claude Code CLI",
          status: "WARN",
          detail: `${v}, latest is ${l}`,
          fix: "claude update",
        };
  },
};

export const ollamaVersion: Check = {
  group: G,
  name: "Ollama",
  run: async (ctx) => {
    const r = await ctx.run("ollama", ["--version"], 20_000);
    const v = /(\d+\.\d+\.\d+)/.exec(`${r.stdout}${r.stderr}`)?.[1];
    return v === undefined
      ? {
          group: G,
          name: "Ollama",
          status: "FAIL",
          detail: "ollama not found",
          fix: "brew install --cask ollama-app",
        }
      : {
          group: G,
          name: "Ollama",
          status: "PASS",
          detail: `${v} (updates show under Homebrew outdated)`,
        };
  },
};

export function modelsCheck(
  policy: () => RoutingPolicy,
  pulled: () => Promise<readonly string[]>,
): Check {
  return {
    group: G,
    name: "models routing.yaml needs",
    run: async () => {
      const have = await pulled();
      const has = (m: string) => have.includes(m) || have.includes(`${m}:latest`);
      const out: CheckResult[] = [];
      const p = policy();
      for (const task of LANE_TASK_TYPES) {
        const s = p.tasks[task]?.ollama;
        if (s === undefined) continue;
        const models = [s.model, ...(s.editor_model !== undefined ? [s.editor_model] : [])];
        const missing = models.filter((m) => !has(m));
        const core = !["embed", "vision"].includes(task);
        out.push(
          missing.length === 0
            ? { group: G, name: `model for ${task}`, status: "PASS", detail: models.join(" + ") }
            : {
                group: G,
                name: `model for ${task}`,
                status: core ? "FAIL" : "WARN",
                detail: `${missing.join(", ")} not pulled${core ? "" : " — this task is unavailable until it is"}`,
                fix: missing.map((m) => `ollama pull ${m}`).join(" && "),
              },
        );
      }
      return out;
    },
  };
}

export function benchCheck(records: () => Record<string, unknown>[]): Check {
  return {
    group: G,
    name: "last moss bench",
    run: async (ctx) => {
      const last = lastBench(records());
      if (last === null)
        return {
          group: G,
          name: "last moss bench",
          status: "WARN",
          detail: "never run",
          fix: "moss bench",
        };
      const days = ageDays(new Date(last.ts), ctx.now());
      return {
        group: G,
        name: "last moss bench",
        status: days > 35 ? "WARN" : "PASS",
        detail: `${days} day(s) ago, ${last.passed}/${last.models} passed`,
        fix: "moss bench",
      };
    },
  };
}

export function lanesCheck(
  lanes: () => Promise<ReadonlyArray<{ id: string; status: string; reason: string }>>,
  tier: (l: ReadonlyArray<{ id: string; status: string }>) => string,
): Check {
  return {
    group: G,
    name: "lanes",
    run: async () => {
      const l = await lanes();
      const state = l
        .map(
          (x) =>
            `${x.id} ${x.status === "available" ? "up" : x.status === "disabled" ? "off" : "down"}`,
        )
        .join(", ");
      const local = l.find((x) => x.id === "ollama")?.status === "available";
      return {
        group: G,
        name: "lanes",
        status: local ? "PASS" : "FAIL",
        detail: `${tier(l)} — ${state}`,
        ...(local ? {} : { fix: "moss local" }),
      };
    },
  };
}
