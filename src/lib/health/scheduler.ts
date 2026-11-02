// Scheduler and backup: is every launchd agent you installed actually loaded, did its last run
// exit cleanly, does it point at a program that exists — and how old is the last backup? This
// is the check whose absence let the backup stop for seven weeks (29 Jul → 18 Sep 2026).
import { join } from "node:path";
import { ageDays, type Check, type CheckResult } from "./types.ts";

const G = "scheduler + backup";
const MINE = /^(com\.karl\.|ie\.karldoyle\.|com\.local\.)/;

export function parseLaunchctlList(text: string): Map<string, { pid: string; status: number }> {
  const out = new Map<string, { pid: string; status: number }>();
  for (const line of text.split("\n")) {
    const [pid, status, label] = line.trim().split(/\s+/);
    if (label !== undefined && status !== undefined && pid !== undefined && pid !== "PID") {
      out.set(label, { pid, status: Number.parseInt(status, 10) });
    }
  }
  return out;
}

// The program a plist runs: <key>Program</key>, else the first ProgramArguments string.
export function plistProgram(xml: string): string | null {
  return (
    /<key>Program<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)?.[1] ??
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(xml)?.[1] ??
    null
  );
}

export const agentsCheck: Check = {
  group: G,
  name: "launchd agents",
  run: async (ctx) => {
    const dir = join(ctx.home, "Library", "LaunchAgents");
    const installed = ctx.listDir(dir).filter((f) => f.endsWith(".plist") && MINE.test(f));
    const loaded = parseLaunchctlList((await ctx.run("launchctl", ["list"], 20_000)).stdout);
    const out: CheckResult[] = installed.map((file) => {
      const label = file.replace(/\.plist$/, "");
      const program = plistProgram(ctx.readText(join(dir, file)) ?? "");
      const state = loaded.get(label);
      const base = { group: G, name: label.replace(/^com\.karl\.cortex\./, "cortex.") };
      if (program?.startsWith("/") && !ctx.exists(program)) {
        return {
          ...base,
          status: "WARN" as const,
          detail: `runs ${program}, which does not exist`,
          fix: `launchctl bootout gui/$(id -u)/${label}; then move ${join(dir, file)} to the Trash (your call)`,
        };
      }
      if (state === undefined) {
        return {
          ...base,
          status: "FAIL" as const,
          detail: "installed but NOT loaded — it will never run",
          fix: `launchctl bootstrap gui/$(id -u) ${join(dir, file)}`,
        };
      }
      if (state.status !== 0) {
        return {
          ...base,
          status: "WARN" as const,
          detail: `loaded; last run exited ${state.status}`,
          fix: `tail ~/Library/Logs/*${label.split(".").at(-1)}*`,
        };
      }
      return { ...base, status: "PASS" as const, detail: "loaded; last exit 0" };
    });
    // Plists kept in Taisce for install that are not installed at all.
    const repoDir = join(ctx.taisceRoot, "scripts", "launchd");
    for (const file of ctx
      .listDir(repoDir)
      .filter((f) => f.endsWith(".plist") && !installed.includes(f))) {
      out.push({
        group: G,
        name: file.replace(/\.plist$/, "").replace(/^com\.karl\.cortex\./, "cortex."),
        status: "WARN",
        detail: "in Taisce scripts/launchd/ but never installed",
        fix: `cp ${join(repoDir, file)} ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${file}`,
      });
    }
    return out.length > 0
      ? out
      : {
          group: G,
          name: "launchd agents",
          status: "WARN",
          detail: "no agents of yours installed",
        };
  },
};

// Where cortex-backup.sh keeps its restic repository (its RESTIC_REPOSITORY line).
export function resticRepo(script: string, home: string): string | null {
  const raw = /RESTIC_REPOSITORY="([^"]+)"/.exec(script)?.[1];
  return raw === undefined ? null : raw.replace(/^\$HOME|^~/, home);
}

// The age of the newest snapshot, read from the restic repository's snapshots/ folder
// (one file per snapshot) — file times only, so no password and no restic call. The launchd
// log is a poor signal: a backup run by hand never writes it.
export const backupCheck: Check = {
  group: G,
  name: "last backup",
  run: async (ctx) => {
    const script = ctx.readText(join(ctx.taisceRoot, "scripts", "cortex-backup.sh"));
    const repo = script === null ? null : resticRepo(script, ctx.home);
    if (repo === null)
      return {
        group: G,
        name: "last backup",
        status: "SKIP",
        detail: "cortex-backup.sh not found",
      };
    const dir = join(repo, "snapshots");
    const newest = ctx
      .listDir(dir)
      .map((f) => ctx.mtime(join(dir, f)))
      .filter((d): d is Date => d !== null)
      .sort((x, y) => y.getTime() - x.getTime())[0];
    if (newest === undefined) {
      return {
        group: G,
        name: "last backup",
        status: "FAIL",
        detail: "no snapshot found in the backup repository",
        fix: "~/context-workspace/scripts/cortex-backup.sh backup",
      };
    }
    const days = ageDays(newest, ctx.now());
    return {
      group: G,
      name: "last backup",
      status: days > 8 ? "FAIL" : "PASS",
      detail: `newest snapshot ${newest.toISOString().slice(0, 16).replace("T", " ")} UTC (${days} day(s) ago)`,
      fix: "plug in the SanDisk (com.karl.backup.on-mount runs the off-site backup), or ~/context-workspace/scripts/cortex-backup.sh backup",
    };
  },
};

export const SCHEDULER_CHECKS: readonly Check[] = [agentsCheck, backupCheck];
