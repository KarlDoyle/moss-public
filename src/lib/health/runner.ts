// Runs the checks in parallel, each with its own time limit, and renders one report. A check
// that throws is reported as FAIL with the error — it never takes the others down with it.
import type { Check, CheckResult, HealthCtx, HealthStatus } from "./types.ts";

const LIMIT_MS = 180_000;
const DEEP_LIMIT_MS = 900_000;

async function runOne(check: Check, ctx: HealthCtx): Promise<CheckResult[]> {
  const limit = check.deep === true ? DEEP_LIMIT_MS : LIMIT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<CheckResult[]>((resolve) => {
    timer = setTimeout(
      () =>
        resolve([
          {
            group: check.group,
            name: check.name,
            status: "FAIL",
            detail: `did not finish within ${limit / 1000}s`,
          },
        ]),
      limit,
    );
  });
  try {
    const done = check.run(ctx).then((r) => (Array.isArray(r) ? r : [r]));
    return await Promise.race([done, timeout]);
  } catch (error) {
    return [
      {
        group: check.group,
        name: check.name,
        status: "FAIL",
        detail: `check crashed: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  } finally {
    clearTimeout(timer);
  }
}

export async function runChecks(checks: readonly Check[], ctx: HealthCtx): Promise<CheckResult[]> {
  const active = checks.filter((c) => ctx.deep || c.deep !== true);
  const skipped: CheckResult[] = checks
    .filter((c) => !ctx.deep && c.deep === true)
    .map((c) => ({ group: c.group, name: c.name, status: "SKIP", detail: "only with --deep" }));
  return [...(await Promise.all(active.map((c) => runOne(c, ctx)))).flat(), ...skipped];
}

const MARK: Record<HealthStatus, string> = {
  PASS: "PASS",
  WARN: "WARN",
  FAIL: "FAIL",
  SKIP: "skip",
};

export function summary(results: readonly CheckResult[]): string {
  const n = (s: HealthStatus) => results.filter((r) => r.status === s).length;
  return `${n("FAIL")} FAIL · ${n("WARN")} WARN · ${n("PASS")} PASS${n("SKIP") > 0 ? ` · ${n("SKIP")} skipped` : ""}`;
}

export function renderReport(results: readonly CheckResult[], when: Date): string {
  const lines = [
    `moss check — ${when.toISOString().slice(0, 16).replace("T", " ")} UTC — report only, nothing was changed`,
  ];
  for (const group of [...new Set(results.map((r) => r.group))]) {
    lines.push("", group);
    for (const r of results.filter((x) => x.group === group)) {
      lines.push(`  ${MARK[r.status]}  ${r.name.padEnd(26)} ${r.detail}`);
      if (r.fix !== undefined && r.status !== "PASS") lines.push(`        fix: ${r.fix}`);
    }
  }
  lines.push("", summary(results));
  return lines.join("\n");
}
