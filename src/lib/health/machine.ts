// Machine: macOS updates, Homebrew, mac-setup's own doctor, Node.
import { join } from "node:path";
import { type Check, lastLine } from "./types.ts";

const G = "machine";

export const macosUpdates: Check = {
  group: G,
  name: "macOS updates",
  run: async (ctx) => {
    const r = await ctx.run("softwareupdate", ["-l"], 90_000);
    const titles = [...`${r.stdout}\n${r.stderr}`.matchAll(/Title:\s*([^,]+)/g)].map((m) =>
      (m[1] ?? "").trim(),
    );
    if (titles.length === 0 && /No new software available/i.test(`${r.stdout}${r.stderr}`)) {
      return { group: G, name: "macOS updates", status: "PASS", detail: "none available" };
    }
    if (titles.length === 0) {
      return {
        group: G,
        name: "macOS updates",
        status: "SKIP",
        detail: `could not read softwareupdate (exit ${r.exitCode})`,
      };
    }
    return {
      group: G,
      name: "macOS updates",
      status: "WARN",
      detail: `${titles.length} available: ${titles.join(", ")}`,
      fix: "System Settings → General → Software Update (a major version needs your go and a backup first)",
    };
  },
};

export const brewOutdated: Check = {
  group: G,
  name: "Homebrew outdated",
  run: async (ctx) => {
    const r = await ctx.run("brew", ["outdated", "--json=v2"], 120_000);
    let names: string[] = [];
    try {
      const d = JSON.parse(r.stdout) as {
        formulae?: Array<{ name: string }>;
        casks?: Array<{ name: string }>;
      };
      names = [...(d.formulae ?? []), ...(d.casks ?? [])].map((x) => x.name);
    } catch {
      return {
        group: G,
        name: "Homebrew outdated",
        status: "SKIP",
        detail: `could not read brew outdated (exit ${r.exitCode})`,
      };
    }
    if (names.length === 0)
      return { group: G, name: "Homebrew outdated", status: "PASS", detail: "everything current" };
    const shown =
      names.slice(0, 8).join(", ") + (names.length > 8 ? `, +${names.length - 8} more` : "");
    return {
      group: G,
      name: "Homebrew outdated",
      status: "WARN",
      detail: `${names.length} outdated: ${shown}`,
      fix: "~/Dev/mac-setup/bin/mac-setup update-plan   (then brew upgrade what it proposes)",
    };
  },
};

export const macSetupDoctor: Check = {
  group: G,
  name: "mac-setup doctor",
  run: async (ctx) => {
    const script = join(ctx.devRoot, "mac-setup", "bin", "mac-setup");
    if (!ctx.exists(script))
      return { group: G, name: "mac-setup doctor", status: "SKIP", detail: "mac-setup not found" };
    const r = await ctx.run("bash", [script, "doctor"], 180_000);
    if (r.exitCode === 0)
      return { group: G, name: "mac-setup doctor", status: "PASS", detail: "clean" };
    const warning =
      /^(Warning|Error):.*$/m.exec(`${r.stdout}\n${r.stderr}`)?.[0] ??
      lastLine(`${r.stdout}\n${r.stderr}`);
    return {
      group: G,
      name: "mac-setup doctor",
      status: "WARN",
      detail: warning.slice(0, 140),
      fix: `${script} doctor`,
    };
  },
};

export const nodeVersion: Check = {
  group: G,
  name: "Node",
  run: async () => {
    const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
    return major >= 22
      ? { group: G, name: "Node", status: "PASS", detail: `v${process.versions.node}` }
      : {
          group: G,
          name: "Node",
          status: "FAIL",
          detail: `v${process.versions.node} — moss needs ≥22`,
          fix: "nvm install 22",
        };
  },
};

export const MACHINE_CHECKS: readonly Check[] = [
  macosUpdates,
  brewOutdated,
  macSetupDoctor,
  nodeVersion,
];
