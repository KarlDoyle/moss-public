// `moss bench` — tok/s, prompt tok/s and cold load for the local models moss uses, appended
// to Taisce System/telemetry/model-bench.jsonl so `moss status` can say when it last ran.
import type { Command } from "commander";
import { type BenchRecord, type BenchTarget, benchModel, formatBenchTable } from "../lib/bench.ts";
import { isReasoningModel, resolveCoderModel } from "../lib/ollama.ts";
import { appendTelemetry, telemetryPath } from "../lib/taisce/telemetry.ts";
import { defaultDoctorDependencies, gatherDiagnostics } from "./doctor.ts";

// The models moss routes to today. Replaced by the task rows in config/routing.yaml once
// the policy layer lands; until then these are the defaults the session already uses.
export function defaultBenchTargets(env: NodeJS.ProcessEnv = process.env): BenchTarget[] {
  return [
    { role: "route", model: "qwen2.5:3b-instruct" },
    { role: "brief", model: env.MOSS_CHAT_MODEL?.trim() || "llama3.1:latest" },
    { role: "edit", model: resolveCoderModel(env) },
  ];
}

export interface BenchDeps {
  readonly pulled: () => Promise<string[]>;
  readonly bench: (target: BenchTarget, now: () => Date) => Promise<BenchRecord>;
  readonly append: (record: BenchRecord) => Promise<void>;
  readonly now: () => Date;
}

export const defaultBenchDeps: BenchDeps = {
  pulled: async () =>
    (await gatherDiagnostics(defaultDoctorDependencies)).ollama.models.map((m) => m.name),
  bench: (target, now) => benchModel(target, now),
  append: (record) => appendTelemetry(telemetryPath("model-bench"), record),
  now: () => new Date(),
};

function isPulled(model: string, pulled: readonly string[]): boolean {
  return pulled.includes(model) || pulled.includes(`${model}:latest`);
}

export async function runBench(
  targets: readonly BenchTarget[],
  out: (line: string) => void,
  err: (line: string) => void,
  deps: BenchDeps = defaultBenchDeps,
): Promise<BenchRecord[]> {
  const pulled = await deps.pulled();
  if (pulled.length === 0) {
    err("moss bench: Ollama is not running or has no models. Run `moss local` first.");
    return [];
  }
  const start = deps.now();
  const records: BenchRecord[] = [];
  for (const target of targets) {
    if (isReasoningModel(target.model)) {
      err(`moss bench: skipping ${target.model} — reasoning models are never benched or used.`);
      continue;
    }
    if (!isPulled(target.model, pulled)) {
      err(
        `moss bench: ${target.model} (${target.role}) is not pulled — skipped, not pulled for you.`,
      );
      continue;
    }
    const record = await deps.bench(target, () => start);
    records.push(record);
    await deps.append(record);
  }
  out(formatBenchTable(records));
  return records;
}

export function registerBench(program: Command): void {
  program
    .command("bench")
    .description(
      "Measure the local models moss uses (tok/s, cold load); logged to Taisce telemetry",
    )
    .option("--model <name>", "Bench one model instead of the routing defaults")
    .action(async (opts: { model?: string }) => {
      const targets =
        opts.model !== undefined ? [{ role: "adhoc", model: opts.model }] : defaultBenchTargets();
      const records = await runBench(
        targets,
        (line) => process.stdout.write(`${line}\n`),
        (line) => process.stderr.write(`${line}\n`),
      );
      if (records.length === 0 || records.some((r) => !r.ok)) process.exitCode = 1;
    });
}
