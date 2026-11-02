import type { HealthCtx, RunOutput } from "../../../src/lib/health/types.ts";

// A fake machine: canned command output, a virtual file system, fixed clock.
export function fakeCtx(opts: {
  runs?: Record<string, Partial<RunOutput>>;
  files?: Record<string, string>;
  mtimes?: Record<string, string>;
  config?: Record<string, string>;
  deep?: boolean;
}): HealthCtx & { calls: string[] } {
  const files = opts.files ?? {};
  const calls: string[] = [];
  const has = (p: string) => p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`));
  return {
    calls,
    run: async (command, args) => {
      const key = [command, ...args].join(" ");
      calls.push(key);
      const hit = Object.entries(opts.runs ?? {}).find(([k]) => key.startsWith(k))?.[1];
      return { exitCode: hit?.exitCode ?? 0, stdout: hit?.stdout ?? "", stderr: hit?.stderr ?? "" };
    },
    gitConfig: async (repo, key) => opts.config?.[`${repo}:${key}`] ?? null,
    readText: (p) => files[p] ?? null,
    mtime: (p) => (opts.mtimes?.[p] !== undefined ? new Date(opts.mtimes[p] as string) : null),
    listDir: (p) => [
      ...new Set(
        Object.keys(files)
          .filter((f) => f.startsWith(`${p}/`))
          .map((f) => f.slice(p.length + 1).split("/")[0] as string),
      ),
    ],
    exists: has,
    now: () => new Date("2026-09-18T20:00:00Z"),
    home: "/H",
    devRoot: "/D",
    taisceRoot: "/D/Taisce",
    deep: opts.deep ?? false,
  };
}
