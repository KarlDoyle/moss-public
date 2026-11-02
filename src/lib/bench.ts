// `moss bench` — measure the local models moss actually uses, on this Mac, with one fixed
// prompt each. Numbers come from Ollama's own counters (eval_duration etc.), not a stopwatch,
// so a slow terminal cannot skew them. Local only, €0.
import { type FetchResult, safeFetch } from "./net.ts";
import { OLLAMA_BASE_URL, ollamaSafety } from "./ollama.ts";

export const BENCH_PROMPT =
  "In exactly one sentence, say what a git worktree gives a developer that a branch alone does not.";

// Short on purpose: the point is throughput and cold load, not a long answer.
export const BENCH_NUM_PREDICT = 96;
export const BENCH_NUM_CTX = 4096;
const BENCH_TIMEOUT_MS = 180_000;

export interface BenchTarget {
  readonly role: string; // what moss uses the model for, e.g. "brief", "edit", "route"
  readonly model: string;
}

export interface BenchRecord {
  readonly ts: string;
  readonly role: string;
  readonly model: string;
  readonly ok: boolean;
  readonly tok_s?: number;
  readonly prompt_tok_s?: number;
  readonly load_ms?: number;
  readonly total_ms?: number;
  readonly output_tokens?: number;
  readonly error?: string;
  readonly by: "moss bench";
}

export type BenchFetch = (
  url: string,
  options: { method: "POST"; headers: Record<string, string>; body: string; timeoutMs: number },
) => Promise<FetchResult>;

interface GenerateCounters {
  response?: string;
  error?: string;
  eval_count?: number;
  eval_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  load_duration?: number;
  total_duration?: number;
}

function rate(count: number | undefined, ns: number | undefined): number | undefined {
  if (count === undefined || ns === undefined || ns <= 0) return undefined;
  return Math.round((count / (ns / 1e9)) * 10) / 10;
}

function ms(ns: number | undefined): number | undefined {
  return ns === undefined ? undefined : Math.round(ns / 1e6);
}

export async function benchModel(
  target: BenchTarget,
  now: () => Date = () => new Date(),
  fetchFn: BenchFetch = safeFetch,
): Promise<BenchRecord> {
  const ts = now().toISOString();
  const base = { ts, role: target.role, model: target.model, by: "moss bench" as const };
  const safety = ollamaSafety({ numCtx: BENCH_NUM_CTX });
  const body = JSON.stringify({
    model: target.model,
    prompt: BENCH_PROMPT,
    stream: false,
    think: safety.think,
    options: { ...safety.options, num_predict: BENCH_NUM_PREDICT, temperature: 0 },
  });
  let result: FetchResult;
  try {
    result = await fetchFn(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      timeoutMs: BENCH_TIMEOUT_MS,
    });
  } catch (error) {
    return { ...base, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  let parsed: GenerateCounters;
  try {
    parsed = JSON.parse(result.body) as GenerateCounters;
  } catch {
    return { ...base, ok: false, error: `HTTP ${result.status}: unparseable body` };
  }
  if (!result.ok || parsed.error !== undefined) {
    return { ...base, ok: false, error: parsed.error ?? `HTTP ${result.status}` };
  }
  const answered = (parsed.response ?? "").trim().length > 0;
  const tokS = rate(parsed.eval_count, parsed.eval_duration);
  const promptTokS = rate(parsed.prompt_eval_count, parsed.prompt_eval_duration);
  const loadMs = ms(parsed.load_duration);
  const totalMs = ms(parsed.total_duration);
  return {
    ...base,
    ok: answered,
    ...(tokS !== undefined ? { tok_s: tokS } : {}),
    ...(promptTokS !== undefined ? { prompt_tok_s: promptTokS } : {}),
    ...(loadMs !== undefined ? { load_ms: loadMs } : {}),
    ...(totalMs !== undefined ? { total_ms: totalMs } : {}),
    ...(parsed.eval_count !== undefined ? { output_tokens: parsed.eval_count } : {}),
    ...(answered ? {} : { error: "empty response" }),
  };
}

export function formatBenchTable(records: readonly BenchRecord[]): string {
  const rows = records.map((r) =>
    r.ok
      ? `  ${r.role.padEnd(8)} ${r.model.padEnd(24)} ${String(r.tok_s ?? "?").padStart(6)} tok/s  prompt ${String(r.prompt_tok_s ?? "?").padStart(6)} tok/s  load ${String(r.load_ms ?? "?").padStart(6)} ms  PASS`
      : `  ${r.role.padEnd(8)} ${r.model.padEnd(24)} FAIL — ${r.error ?? "unknown"}`,
  );
  return ["moss bench — Ollama counters, one fixed prompt per model", ...rows].join("\n");
}

// The most recent bench run, from the telemetry file's records (newest last).
export function lastBench(
  records: readonly Record<string, unknown>[],
): { readonly ts: string; readonly models: number; readonly passed: number } | null {
  const benches = records.filter((r) => r.by === "moss bench" && typeof r.ts === "string");
  const last = benches.at(-1);
  if (last === undefined) return null;
  // One run shares one timestamp (the command stamps every target with the run's start).
  const run = benches.filter((r) => r.ts === last.ts);
  return {
    ts: String(last.ts),
    models: run.length,
    passed: run.filter((r) => r.ok === true).length,
  };
}
