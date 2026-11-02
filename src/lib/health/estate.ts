// Estate: Taisce's own checks (run by path, never re-implemented), git hooks that never fire,
// repos with no dependency-update config, and — with --deep — every repo's tests and the bot
// PRs piling up unmerged.
import { join } from "node:path";
import { type Check, type CheckResult, lastLine } from "./types.ts";

const G = "estate";

function taisceScript(
  name: string,
  script: string,
  args: string[],
  read: (out: string, code: number) => Omit<CheckResult, "group" | "name" | "fix">,
): Check {
  return {
    group: G,
    name,
    run: async (ctx) => {
      const path = join(ctx.taisceRoot, "scripts", script);
      if (!ctx.exists(path))
        return { group: G, name, status: "SKIP", detail: `${script} not found` };
      const r = await ctx.run("bash", [path, ...args], 120_000);
      return {
        group: G,
        name,
        ...read(`${r.stdout}\n${r.stderr}`, r.exitCode),
        fix: `~/context-workspace/scripts/${script} ${args.join(" ")}`.trim(),
      };
    },
  };
}

export const guardrails = taisceScript(
  "Taisce guardrails",
  "check-guardrails.sh",
  [],
  (out, code) => ({
    status: code === 0 ? "PASS" : "FAIL",
    detail: lastLine(out).replace(/^check-guardrails:\s*/, ""),
  }),
);

export const pulse = taisceScript("Taisce Pulse", "check-pulse.sh", ["--brief"], (out, code) => {
  const line = /^PULSE:.*$/m.exec(out)?.[0] ?? lastLine(out);
  const overdue = Number.parseInt(/(\d+) overdue/.exec(line)?.[1] ?? "0", 10);
  return {
    status: code !== 0 ? "FAIL" : overdue > 0 ? "WARN" : "PASS",
    detail: line.replace(/^PULSE:\s*/, "").slice(0, 150),
  };
});

export const staleness = taisceScript("Taisce staleness", "check-staleness.sh", [], (out, code) => {
  const n = out.split("\n").filter((l) => /\d+d old/.test(l)).length;
  return {
    status: code === 0 ? "PASS" : "WARN",
    detail: code === 0 ? "nothing past its review window" : `${n} file(s) past their review window`,
  };
});

export const estateDocs = taisceScript("estate docs", "check-estate-docs.sh", [], (out) => {
  const n = Number.parseInt(/(\d+) item\(s\) past/.exec(out)?.[1] ?? "0", 10);
  return {
    status: n > 0 ? "WARN" : "PASS",
    detail: n > 0 ? `${n} doc(s) past their review window` : "all current",
  };
});

function repos(ctx: Parameters<Check["run"]>[0]): string[] {
  return ctx
    .listDir(ctx.devRoot)
    .filter((d) => !d.startsWith("_") && !d.startsWith("."))
    .map((d) => join(ctx.devRoot, d))
    .filter((p) => ctx.exists(join(p, ".git")));
}

export const hooksCheck: Check = {
  group: G,
  name: "pre-push hooks active",
  run: async (ctx) => {
    const idle: string[] = [];
    for (const repo of repos(ctx).filter((r) => ctx.exists(join(r, ".githooks", "pre-push")))) {
      if ((await ctx.gitConfig(repo, "core.hooksPath")) !== ".githooks") idle.push(repo);
    }
    return idle.length === 0
      ? {
          group: G,
          name: "pre-push hooks active",
          status: "PASS",
          detail: "every repo with .githooks/pre-push runs it",
        }
      : {
          group: G,
          name: "pre-push hooks active",
          status: "WARN",
          detail: `never run in: ${idle.map((r) => r.split("/").at(-1)).join(", ")}`,
          fix: idle.map((r) => `git -C ${r} config core.hooksPath .githooks`).join(" ; "),
        };
  },
};

export const dependabotCheck: Check = {
  group: G,
  name: "dependency-update config",
  run: async (ctx) => {
    const missing = repos(ctx)
      .filter((r) => ctx.exists(join(r, ".github", "workflows")))
      .filter(
        (r) =>
          !ctx.exists(join(r, ".github", "dependabot.yml")) &&
          !ctx.exists(join(r, ".github", "dependabot.yaml")),
      );
    return missing.length === 0
      ? {
          group: G,
          name: "dependency-update config",
          status: "PASS",
          detail: "every repo with CI has .github/dependabot.yml",
        }
      : {
          group: G,
          name: "dependency-update config",
          status: "WARN",
          detail: `no dependabot.yml in ${missing.length} repo(s) with CI: ${missing.map((r) => r.split("/").at(-1)).join(", ")}`,
        };
  },
};

export const verifyAll: Check = {
  group: G,
  name: "all repos' tests (verify-all)",
  deep: true,
  run: async (ctx) => {
    const script = join(ctx.devRoot, "shared build tooling", "scripts", "verify-all.sh");
    if (!ctx.exists(script))
      return {
        group: G,
        name: "all repos' tests (verify-all)",
        status: "SKIP",
        detail: "shared build tooling verify-all.sh not found",
      };
    const r = await ctx.run("bash", [script], 840_000);
    return {
      group: G,
      name: "all repos' tests (verify-all)",
      status: r.exitCode === 0 ? "PASS" : "FAIL",
      detail: lastLine(`${r.stdout}\n${r.stderr}`).slice(0, 150),
      fix: script,
    };
  },
};

export const botPrs: Check = {
  group: G,
  name: "bot PRs waiting (Taisce)",
  deep: true,
  run: async (ctx) => {
    const url = (await ctx.gitConfig(ctx.taisceRoot, "remote.origin.url")) ?? "";
    const slug = /github\.com[:/]([^/]+\/[^/.]+)/.exec(url)?.[1];
    if (slug === undefined)
      return {
        group: G,
        name: "bot PRs waiting (Taisce)",
        status: "SKIP",
        detail: "no GitHub remote",
      };
    const r = await ctx.run(
      "gh",
      ["pr", "list", "-R", slug, "--state", "open", "--json", "headRefName", "--limit", "100"],
      60_000,
    );
    let heads: string[] = [];
    try {
      heads = (JSON.parse(r.stdout) as Array<{ headRefName: string }>).map((p) => p.headRefName);
    } catch {
      return {
        group: G,
        name: "bot PRs waiting (Taisce)",
        status: "SKIP",
        detail: "gh could not list PRs",
      };
    }
    const bots = heads.filter((h) => /^(knowledge-loop|context-self-heal)\//.test(h));
    return bots.length === 0
      ? { group: G, name: "bot PRs waiting (Taisce)", status: "PASS", detail: "none open" }
      : {
          group: G,
          name: "bot PRs waiting (Taisce)",
          status: "WARN",
          detail: `${bots.length} open, unmerged — the loops run green but land nothing`,
          fix: `gh pr list -R ${slug}   (merge or close: your decision)`,
        };
  },
};

export const ESTATE_CHECKS: readonly Check[] = [
  guardrails,
  pulse,
  staleness,
  estateDocs,
  hooksCheck,
  dependabotCheck,
  verifyAll,
  botPrs,
];
