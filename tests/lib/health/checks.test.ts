import { describe, expect, it } from "vitest";
import {
  benchCheck,
  claudeCli,
  lanesCheck,
  modelsCheck,
  ollamaVersion,
} from "../../../src/lib/health/ai.ts";
import {
  botPrs,
  dependabotCheck,
  guardrails,
  hooksCheck,
  pulse,
  staleness,
  verifyAll,
} from "../../../src/lib/health/estate.ts";
import {
  brewOutdated,
  macosUpdates,
  macSetupDoctor,
  nodeVersion,
} from "../../../src/lib/health/machine.ts";
import { renderReport, runChecks, summary } from "../../../src/lib/health/runner.ts";
import {
  agentsCheck,
  backupCheck,
  parseLaunchctlList,
  plistProgram,
  resticRepo,
} from "../../../src/lib/health/scheduler.ts";
import type { Check, CheckResult } from "../../../src/lib/health/types.ts";
import { policy } from "../lanes/fixtures.ts";
import { fakeCtx } from "./fake.ts";

const one = async (c: Check, ctx = fakeCtx({})) => {
  const r = await c.run(ctx);
  return Array.isArray(r) ? (r[0] as CheckResult) : r;
};

describe("machine", () => {
  it("macOS updates: none, some, unreadable", async () => {
    expect(
      (
        await one(
          macosUpdates,
          fakeCtx({ runs: { softwareupdate: { stderr: "No new software available." } } }),
        )
      ).status,
    ).toBe("PASS");
    const some = await one(
      macosUpdates,
      fakeCtx({
        runs: { softwareupdate: { stdout: "* Label: x\n\tTitle: macOS 27, Version: 27, Size: 1" } },
      }),
    );
    expect(some).toMatchObject({ status: "WARN", detail: "1 available: macOS 27" });
    expect(
      (await one(macosUpdates, fakeCtx({ runs: { softwareupdate: { exitCode: 1 } } }))).status,
    ).toBe("SKIP");
  });

  it("brew outdated: counts formulae and casks, suggests the plan, never upgrades", async () => {
    const out = JSON.stringify({ formulae: [{ name: "restic" }], casks: [{ name: "ollama-app" }] });
    const ctx = fakeCtx({ runs: { "brew outdated": { stdout: out } } });
    expect(await one(brewOutdated, ctx)).toMatchObject({
      status: "WARN",
      detail: "2 outdated: restic, ollama-app",
    });
    expect(ctx.calls).toEqual(["brew outdated --json=v2"]);
    expect(
      (
        await one(
          brewOutdated,
          fakeCtx({ runs: { "brew outdated": { stdout: '{"formulae":[],"casks":[]}' } } }),
        )
      ).status,
    ).toBe("PASS");
    expect(
      (await one(brewOutdated, fakeCtx({ runs: { "brew outdated": { stdout: "nope" } } }))).status,
    ).toBe("SKIP");
  });

  it("mac-setup doctor: clean, warning, missing; Node ≥24", async () => {
    const files = { "/D/mac-setup/bin/mac-setup": "#!/bin/bash" };
    expect((await one(macSetupDoctor, fakeCtx({ files }))).status).toBe("PASS");
    const warn = await one(
      macSetupDoctor,
      fakeCtx({
        files,
        runs: { bash: { exitCode: 1, stdout: "ok\nWarning: taps not trusted\nmore" } },
      }),
    );
    expect(warn).toMatchObject({ status: "WARN", detail: "Warning: taps not trusted" });
    expect((await one(macSetupDoctor)).status).toBe("SKIP");
    expect((await one(nodeVersion)).status).toBe("PASS");
  });
});

describe("AI tools", () => {
  it("Claude CLI against the published version", async () => {
    const at = (have: string, latest: string) =>
      one(
        claudeCli,
        fakeCtx({ runs: { "claude --version": { stdout: have }, "npm view": { stdout: latest } } }),
      );
    expect((await at("2.1.277 (Claude Code)", "2.1.277")).status).toBe("PASS");
    expect(await at("2.1.276 (Claude Code)", "2.1.277")).toMatchObject({
      status: "WARN",
      fix: "claude update",
    });
    expect((await at("", "2.1.277")).status).toBe("WARN");
    expect((await at("2.1.277", "")).detail).toContain("could not reach npm");
    expect(
      (
        await one(
          ollamaVersion,
          fakeCtx({ runs: { ollama: { stdout: "ollama version is 0.32.1" } } }),
        )
      ).detail,
    ).toContain("0.32.1");
    expect(
      (await one(ollamaVersion, fakeCtx({ runs: { ollama: { exitCode: 127 } } }))).status,
    ).toBe("FAIL");
  });

  it("models: a missing core model FAILs, a missing embed/vision model WARNs, with the pull", async () => {
    const results = (await modelsCheck(
      () => policy,
      async () => ["llama3.1:latest", "qwen2.5-coder:7b"],
    ).run(fakeCtx({}))) as CheckResult[];
    const by = (task: string) => results.find((r) => r.name === `model for ${task}`);
    expect(by("brief")?.status).toBe("PASS");
    expect(by("route")).toMatchObject({ status: "FAIL", fix: "ollama pull qwen2.5:3b-instruct" });
    expect(by("vision")?.status).toBe("WARN");
  });

  it("bench age and lanes", async () => {
    expect((await one(benchCheck(() => []))).status).toBe("WARN");
    expect(
      (await one(benchCheck(() => [{ by: "moss bench", ts: "2026-07-01T00:00:00Z", ok: true }])))
        .status,
    ).toBe("WARN");
    expect(
      (await one(benchCheck(() => [{ by: "moss bench", ts: "2026-09-10T00:00:00Z", ok: true }])))
        .status,
    ).toBe("PASS");
    const lanes = (ollama: string) =>
      lanesCheck(
        async () => [
          { id: "ollama", status: ollama, reason: "" },
          { id: "anthropic-api", status: "disabled", reason: "" },
        ],
        () => "Tier 3",
      );
    expect((await one(lanes("available"))).detail).toBe("Tier 3 — ollama up, anthropic-api off");
    expect(await one(lanes("unavailable"))).toMatchObject({ status: "FAIL", fix: "moss local" });
  });
});

describe("scheduler + backup", () => {
  const plist = (prog: string) =>
    `<plist><dict><key>ProgramArguments</key><array><string>${prog}</string></array></dict></plist>`;

  it("parses launchctl and plists", () => {
    const m = parseLaunchctlList(
      "PID\tStatus\tLabel\n-\t0\tcom.karl.cortex.backup\n123\t1\tie.karldoyle.leadscout.daily",
    );
    expect(m.get("com.karl.cortex.backup")).toEqual({ pid: "-", status: 0 });
    expect(m.get("ie.karldoyle.leadscout.daily")?.status).toBe(1);
    expect(plistProgram(plist("/bin/x"))).toBe("/bin/x");
    expect(plistProgram("<key>Program</key><string>/p</string>")).toBe("/p");
    expect(plistProgram("")).toBeNull();
  });

  it("an installed agent that is not loaded FAILs — the seven-week backup gap", async () => {
    const la = "/H/Library/LaunchAgents";
    const ctx = fakeCtx({
      files: {
        [`${la}/com.karl.cortex.backup.plist`]: plist("/D/Taisce/scripts/cortex-backup.sh"),
        [`${la}/com.karl.cortex.worklog.plist`]: plist("/D/Taisce/scripts/worklog.sh"),
        [`${la}/com.local.shed.plist`]: plist("/gone/shed"),
        [`${la}/com.apple.other.plist`]: plist("/x"),
        "/D/Taisce/scripts/cortex-backup.sh": "",
        "/D/Taisce/scripts/worklog.sh": "",
        "/D/Taisce/scripts/launchd/com.karl.cortex.backup.plist": "",
        "/D/Taisce/scripts/launchd/com.karl.cortex.leverage-board.plist": "",
      },
      runs: { launchctl: { stdout: "-\t0\tcom.karl.cortex.worklog\n" } },
    });
    const results = (await agentsCheck.run(ctx)) as CheckResult[];
    const by = (n: string) => results.find((r) => r.name === n);
    expect(by("cortex.backup")).toMatchObject({
      status: "FAIL",
      detail: "installed but NOT loaded — it will never run",
    });
    expect(by("cortex.backup")?.fix).toContain("launchctl bootstrap gui/$(id -u)");
    expect(by("cortex.worklog")?.status).toBe("PASS");
    expect(by("com.local.shed")).toMatchObject({
      status: "WARN",
      detail: "runs /gone/shed, which does not exist",
    });
    expect(by("cortex.leverage-board")?.detail).toContain("never installed");
    expect(results.some((r) => r.name.includes("apple"))).toBe(false);
  });

  it("backup age comes from the newest restic snapshot file, not the launchd log", async () => {
    const script = 'export RESTIC_REPOSITORY="$HOME/Backups/repo"';
    expect(resticRepo(script, "/H")).toBe("/H/Backups/repo");
    const ctx = (snapshotDate: string) =>
      fakeCtx({
        files: {
          "/D/Taisce/scripts/cortex-backup.sh": script,
          "/H/Backups/repo/snapshots/a": "",
          "/H/Backups/repo/snapshots/b": "",
        },
        mtimes: {
          "/H/Backups/repo/snapshots/a": "2026-07-29T20:30:00Z",
          "/H/Backups/repo/snapshots/b": snapshotDate,
        },
      });
    expect((await one(backupCheck, ctx("2026-09-18T19:14:00Z"))).status).toBe("PASS");
    expect(await one(backupCheck, ctx("2026-07-29T20:30:00Z"))).toMatchObject({
      status: "FAIL",
      detail: expect.stringContaining("50 day(s) ago"),
    });
    expect(
      (await one(backupCheck, fakeCtx({ files: { "/D/Taisce/scripts/cortex-backup.sh": script } })))
        .status,
    ).toBe("FAIL");
    expect((await one(backupCheck)).status).toBe("SKIP");
  });
});

describe("estate", () => {
  const scripts = {
    "/D/Taisce/scripts/check-guardrails.sh": "",
    "/D/Taisce/scripts/check-pulse.sh": "",
    "/D/Taisce/scripts/check-staleness.sh": "",
  };

  it("runs Taisce's own scripts by path and reads their verdicts", async () => {
    const ctx = fakeCtx({
      files: scripts,
      runs: {
        "bash /D/Taisce/scripts/check-guardrails.sh": {
          stdout: "check-guardrails: all checks passed, 0 WARN",
        },
        "bash /D/Taisce/scripts/check-pulse.sh": {
          stdout: "PULSE: 5 due, 17 overdue — a (never)\nSTALENESS: x",
        },
        "bash /D/Taisce/scripts/check-staleness.sh": {
          exitCode: 1,
          stdout: "a.md — 55d old\nb.md — 9d old",
        },
      },
    });
    expect(await one(guardrails, ctx)).toMatchObject({
      status: "PASS",
      detail: "all checks passed, 0 WARN",
    });
    expect(await one(pulse, ctx)).toMatchObject({
      status: "WARN",
      detail: "5 due, 17 overdue — a (never)",
    });
    expect(await one(staleness, ctx)).toMatchObject({
      status: "WARN",
      detail: "2 file(s) past their review window",
    });
    expect((await one(guardrails)).status).toBe("SKIP");
  });

  it("finds repos whose pre-push hook never runs, and repos with CI but no dependabot.yml", async () => {
    const ctx = fakeCtx({
      files: {
        "/D/a/.git/HEAD": "",
        "/D/a/.githooks/pre-push": "",
        "/D/a/.github/workflows/ci.yml": "",
        "/D/b/.git/HEAD": "",
        "/D/b/.githooks/pre-push": "",
        "/D/b/.github/workflows/ci.yml": "",
        "/D/b/.github/dependabot.yml": "",
        "/D/_archive/.git/HEAD": "",
      },
      config: { "/D/b:core.hooksPath": ".githooks" },
    });
    expect(await one(hooksCheck, ctx)).toMatchObject({
      status: "WARN",
      detail: "never run in: a",
      fix: "git -C /D/a config core.hooksPath .githooks",
    });
    expect(await one(dependabotCheck, ctx)).toMatchObject({
      status: "WARN",
      detail: expect.stringContaining("1 repo(s) with CI: a"),
    });
  });

  it("deep checks: verify-all and waiting bot PRs", async () => {
    const ctx = fakeCtx({
      files: { "/D/shared build tooling/scripts/verify-all.sh": "" },
      runs: {
        "bash /D/shared build tooling/scripts/verify-all.sh": {
          exitCode: 1,
          stdout: "summary: 4 PASS  1 FAIL  0 SKIP",
        },
        "gh pr list": {
          stdout: JSON.stringify([
            { headRefName: "knowledge-loop/12" },
            { headRefName: "context-self-heal/3" },
            { headRefName: "feature/x" },
          ]),
        },
      },
      config: { "/D/Taisce:remote.origin.url": "git@github.com:example/context-source.git" },
      deep: true,
    });
    expect(await one(verifyAll, ctx)).toMatchObject({
      status: "FAIL",
      detail: "summary: 4 PASS  1 FAIL  0 SKIP",
    });
    expect(await one(botPrs, ctx)).toMatchObject({
      status: "WARN",
      detail: expect.stringContaining("2 open"),
    });
    expect(ctx.calls).toContain(
      "gh pr list -R example/context-source --state open --json headRefName --limit 100",
    );
  });
});

describe("runner", () => {
  it("runs checks in parallel, skips deep ones unless asked, and survives a crash", async () => {
    const ok: Check = {
      group: "g",
      name: "ok",
      run: async () => ({ group: "g", name: "ok", status: "PASS", detail: "fine" }),
    };
    const boom: Check = {
      group: "g",
      name: "boom",
      run: async () => Promise.reject(new Error("kaput")),
    };
    const deep: Check = {
      group: "g",
      name: "deep",
      deep: true,
      run: async () => ({ group: "g", name: "deep", status: "WARN", detail: "slow", fix: "do x" }),
    };
    const light = await runChecks([ok, boom, deep], fakeCtx({}));
    expect(light.map((r) => [r.name, r.status])).toEqual([
      ["ok", "PASS"],
      ["boom", "FAIL"],
      ["deep", "SKIP"],
    ]);
    expect(light[1]?.detail).toBe("check crashed: kaput");
    const all = await runChecks([ok, deep], fakeCtx({ deep: true }));
    expect(summary(all)).toBe("0 FAIL · 1 WARN · 1 PASS");
    expect(summary(light)).toBe("1 FAIL · 0 WARN · 1 PASS · 1 skipped");
    const text = renderReport(all, new Date("2026-09-18T20:00:00Z"));
    expect(text).toContain("report only, nothing was changed");
    expect(text).toContain("fix: do x");
  });
});

describe("estateRoot", () => {
  it("is Taisce's parent, even when Taisce is a worktree", async () => {
    const { estateRoot } = await import("../../../src/lib/health/context.ts");
    expect(estateRoot("/U/Dev/Taisce")).toBe("/U/Dev");
    expect(estateRoot("/U/Dev/Taisce/.claude/worktrees/x")).toBe("/U/Dev");
  });
});
