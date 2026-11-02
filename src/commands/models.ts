import type { Command } from "commander";
import {
  defaultEvalRunnerDependencies,
  type EvalDispatcher,
  type EvalRunnerDependencies,
  runModelEvals,
} from "../lib/evals/runner.ts";
import { DEFAULT_EVAL_SPECS } from "../lib/evals/specs.ts";
import type { EvalSpec, ModelEvals } from "../lib/evals/types.ts";
import {
  formatRouteExplanationHuman as formatProviderExplanationHuman,
  formatRouteExplanationJson as formatProviderExplanationJson,
} from "../lib/providers/explain-render.ts";
import { TASK_IDS, type TaskId } from "../lib/providers/index.ts";
import { defaultOllamaProviderDependencies, ollamaGenerate } from "../lib/providers/ollama.ts";
import {
  defaultRouterDependencies,
  explainProviderRoute,
  type RouterDependencies,
} from "../lib/providers/router.ts";
import {
  applyEvalResults,
  defaultRegistryDependencies,
  loadRegistry,
  type Registry,
  RegistryNotFoundError,
  refreshRegistry,
} from "../lib/registry.ts";
import { explainRoute, formatRouteExplanationHuman } from "../lib/route.ts";

export interface ModelsCommandOptions {
  readonly emitJson: boolean;
  readonly refresh: boolean;
  readonly explain?: string;
  // M4: when true, run the default eval suite against every model in
  // the registry, persist results, and rewrite confidence.
  readonly evalAll?: boolean;
  // M4: optional override for the eval specs (tests pin a smaller
  // set to keep CI deterministic).
  readonly evalSpecs?: readonly EvalSpec[];
  // M4: optional dispatcher injection. Production uses an Ollama-backed
  // adapter built from the existing provider; tests inject a fake.
  readonly evalDispatcher?: EvalDispatcher;
  // M4: optional runner-deps injection (clock, monotonic clock, version).
  readonly evalRunnerDeps?: EvalRunnerDependencies;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly deps?: typeof defaultRegistryDependencies;
  readonly routerDeps?: RouterDependencies;
}

function formatRegistryHuman(registry: Registry): string {
  if (registry.models.length === 0) {
    return [
      `Registry generated ${registry.generatedAt} (source: ${registry.source}).`,
      "No models registered. Pull at least one Ollama model (for example `ollama pull llama3.2:3b`)",
      "and run `moss models --refresh`.",
    ].join("\n");
  }
  const header = `Registry generated ${registry.generatedAt} (source: ${registry.source}).`;
  const sorted = [...registry.models].sort((a, b) => b.confidence - a.confidence);
  const rows = sorted.map((m) => {
    const size = m.parameterSize ? ` ${m.parameterSize}` : "";
    const quant = m.quantization ? ` ${m.quantization}` : "";
    const confidence = `confidence=${m.confidence.toFixed(2)}`;
    return `  - ${m.name}${size}${quant}  (${confidence})`;
  });
  return [header, "", "Available models (sorted by confidence):", ...rows].join("\n");
}

export async function runModelsCommand(options: ModelsCommandOptions): Promise<Registry | null> {
  const deps = options.deps ?? defaultRegistryDependencies;
  if (options.refresh) {
    try {
      const registry = await refreshRegistry(deps);
      options.out(
        options.emitJson ? JSON.stringify(registry, null, 2) : formatRegistryHuman(registry),
      );
      return registry;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.err(`moss models --refresh failed: ${message}`);
      return null;
    }
  }

  if (options.evalAll === true) {
    return runEvalAll(options, deps);
  }

  try {
    const registry = await loadRegistry(deps);
    if (options.explain !== undefined) {
      const modelExplanation = explainRoute(registry, options.explain);
      // M3-T07: if the requested task maps to a known M3 TaskId, also
      // compute the provider-layer explanation so operators see BOTH
      // "which model in which provider" (registry layer) and "which
      // provider would actually run it" (router layer). Tasks outside
      // TASK_IDS (e.g. M2's `summarise`/`general`) still get the
      // model-only view — the router only knows about the closed
      // TASK_IDS union and doesn't pretend otherwise.
      const taskIsProviderKnown = (TASK_IDS as readonly string[]).includes(options.explain);
      const routerDeps = options.routerDeps ?? defaultRouterDependencies;
      const providerExplanation = taskIsProviderKnown
        ? await explainProviderRoute(options.explain as TaskId, routerDeps)
        : null;

      if (options.emitJson) {
        options.out(
          JSON.stringify(
            {
              modelExplanation,
              providerExplanation:
                providerExplanation !== null
                  ? formatProviderExplanationJson(providerExplanation)
                  : null,
            },
            null,
            2,
          ),
        );
      } else {
        const parts = [formatRouteExplanationHuman(modelExplanation)];
        if (providerExplanation !== null) {
          parts.push("");
          parts.push(
            formatProviderExplanationHuman(providerExplanation, {
              heading: "Provider routing",
            }),
          );
        }
        options.out(parts.join("\n"));
      }
      return registry;
    }
    options.out(
      options.emitJson ? JSON.stringify(registry, null, 2) : formatRegistryHuman(registry),
    );
    return registry;
  } catch (error) {
    if (error instanceof RegistryNotFoundError) {
      options.err(error.message);
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    options.err(`moss models failed: ${message}`);
    return null;
  }
}

export function registerModels(program: Command): void {
  program
    .command("models")
    .description("List models in the local registry; --refresh rebuilds from Ollama")
    .option("--refresh", "Rebuild the registry from the local Ollama daemon")
    .option(
      "--explain <task>",
      "Explain how Moss would route a task (ask | code-review | summarise | general)",
    )
    .option(
      "--eval",
      "Run the built-in eval suite against every model in the registry and update confidence",
    )
    .option("--json", "Emit JSON instead of human-readable text")
    .action(
      async (commandOpts: {
        refresh?: boolean;
        explain?: string;
        eval?: boolean;
        json?: boolean;
      }) => {
        const globalOpts = program.opts<{ json?: boolean }>();
        const options: ModelsCommandOptions = {
          refresh: Boolean(commandOpts.refresh),
          evalAll: Boolean(commandOpts.eval),
          emitJson: Boolean(commandOpts.json) || Boolean(globalOpts.json),
          out: (line) => process.stdout.write(`${line}\n`),
          err: (line) => process.stderr.write(`${line}\n`),
        };
        if (commandOpts.explain !== undefined) {
          Object.assign(options, { explain: commandOpts.explain });
        }
        const result = await runModelsCommand(options);
        if (result === null) {
          process.exitCode = 1;
        }
      },
    );
}

// -----------------------------------------------------------------------------
// `moss models --eval`
// -----------------------------------------------------------------------------

// Production dispatcher: routes every eval prompt through the existing
// Ollama provider's generate adapter. The provider already lives behind
// `src/lib/net.ts`'s 127.0.0.1:11434 allowlist, so no new network
// surface is opened by M4.
function defaultEvalDispatcher(): EvalDispatcher {
  return {
    providerId: "ollama",
    generate: async (input) => {
      const result = await ollamaGenerate(
        {
          task: "ask",
          prompt: input.prompt,
          model: input.model,
        },
        defaultOllamaProviderDependencies,
      );
      return { response: result.response };
    },
  };
}

interface EvalAllJsonEntry {
  readonly model: string;
  readonly aggregateScore: number;
  readonly results: ModelEvals["results"];
  readonly recordedAt: string;
}

function formatEvalSummaryHuman(entries: readonly EvalAllJsonEntry[]): string {
  if (entries.length === 0) {
    return "No models in the registry; run `moss models --refresh` first, then re-run --eval.";
  }
  const sorted = [...entries].sort((a, b) => b.aggregateScore - a.aggregateScore);
  const lines: string[] = ["Eval results (sorted by aggregate score):"];
  for (const entry of sorted) {
    lines.push("");
    lines.push(`  ${entry.model}  aggregate=${entry.aggregateScore.toFixed(3)}`);
    for (const r of entry.results) {
      lines.push(
        `    - [${r.outcome}] ${r.id} (${r.dimension}) score=${r.score.toFixed(3)} duration=${r.durationMs}ms — ${r.reason}`,
      );
    }
  }
  return lines.join("\n");
}

async function runEvalAll(
  options: ModelsCommandOptions,
  registryDeps: typeof defaultRegistryDependencies,
): Promise<Registry | null> {
  let registry: Registry;
  try {
    registry = await loadRegistry(registryDeps);
  } catch (error) {
    if (error instanceof RegistryNotFoundError) {
      options.err(error.message);
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    options.err(`moss models --eval failed to load registry: ${message}`);
    return null;
  }

  if (registry.models.length === 0) {
    const empty: readonly EvalAllJsonEntry[] = [];
    options.out(
      options.emitJson ? JSON.stringify({ models: empty }, null, 2) : formatEvalSummaryHuman(empty),
    );
    return registry;
  }

  const specs = options.evalSpecs ?? DEFAULT_EVAL_SPECS;
  const dispatcher = options.evalDispatcher ?? defaultEvalDispatcher();
  const runnerDeps = options.evalRunnerDeps ?? defaultEvalRunnerDependencies;

  let current = registry;
  const entries: EvalAllJsonEntry[] = [];
  for (const model of registry.models) {
    let evals: ModelEvals;
    try {
      evals = await runModelEvals(model.name, specs, dispatcher, runnerDeps);
    } catch (error) {
      // We DO surface dispatch-level errors as a hard failure for the
      // single model and continue with the next. Other models on the
      // box may still evaluate cleanly.
      const message = error instanceof Error ? error.message : String(error);
      options.err(`moss models --eval: ${model.name} did not evaluate cleanly: ${message}`);
      continue;
    }
    try {
      current = await applyEvalResults(model.name, evals, registryDeps);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.err(`moss models --eval: persisting results for ${model.name} failed: ${message}`);
      continue;
    }
    entries.push({
      model: model.name,
      aggregateScore: evals.aggregateScore,
      results: evals.results,
      recordedAt: evals.lastRunAt,
    });
  }

  options.out(
    options.emitJson
      ? JSON.stringify({ models: entries }, null, 2)
      : formatEvalSummaryHuman(entries),
  );
  return current;
}
