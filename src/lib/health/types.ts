// `moss check` — one report on whether the machine, the AI tools, the scheduler and the estate
// are healthy and current. Every check is report-only: it may suggest a fix command, it never
// runs one. Each check gets its side effects from HealthCtx, so all of them are testable.

export type HealthStatus = "PASS" | "WARN" | "FAIL" | "SKIP";

export interface CheckResult {
  readonly group: string;
  readonly name: string;
  readonly status: HealthStatus;
  readonly detail: string;
  // The exact command that would fix it — shown, never run.
  readonly fix?: string;
}

export interface RunOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HealthCtx {
  readonly run: (
    command: string,
    args: readonly string[],
    timeoutMs?: number,
  ) => Promise<RunOutput>;
  readonly gitConfig: (repo: string, key: string) => Promise<string | null>;
  readonly readText: (path: string) => string | null;
  readonly mtime: (path: string) => Date | null;
  readonly listDir: (path: string) => string[];
  readonly exists: (path: string) => boolean;
  readonly now: () => Date;
  readonly home: string;
  readonly devRoot: string;
  readonly taisceRoot: string;
  readonly deep: boolean;
}

export interface Check {
  readonly group: string;
  readonly name: string;
  readonly deep?: boolean; // only with --deep (slow, or calls GitHub)
  readonly run: (ctx: HealthCtx) => Promise<CheckResult | CheckResult[]>;
}

export const DAY_MS = 86_400_000;

export function ageDays(from: Date, now: Date): number {
  return Math.floor((now.getTime() - from.getTime()) / DAY_MS);
}

export function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.at(-1) ?? "";
}
