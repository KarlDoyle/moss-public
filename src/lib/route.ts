import { bestModel, type ModelEntry, type Registry } from "./registry.ts";

export type TaskKind = "ask" | "code-review" | "summarise" | "general";

const KNOWN_TASKS: ReadonlySet<TaskKind> = new Set(["ask", "code-review", "summarise", "general"]);

export interface RouteExplanation {
  readonly task: TaskKind;
  readonly chosen: ModelEntry | null;
  readonly considered: readonly ModelEntry[];
  readonly rationale: readonly string[];
}

export function normaliseTask(input: string): TaskKind {
  const lower = input.trim().toLowerCase();
  if (KNOWN_TASKS.has(lower as TaskKind)) {
    return lower as TaskKind;
  }
  return "general";
}

export function explainRoute(registry: Registry, taskInput: string): RouteExplanation {
  const task = normaliseTask(taskInput);
  const sorted = [...registry.models].sort((a, b) => b.confidence - a.confidence);
  const rationale: string[] = [];

  rationale.push(
    "Moss runs a full multi-lane router with deterministic lane selection; the local Ollama lane is the generation-ready lane, so this view ranks the Ollama models recorded in the registry by confidence.",
  );
  rationale.push(`Task category: '${task}'.`);

  if (sorted.length === 0) {
    rationale.push(
      "Registry is empty. Run `moss models --refresh` after pulling at least one Ollama model.",
    );
    return { task, chosen: null, considered: [], rationale };
  }

  const chosen = bestModel(registry);
  if (chosen) {
    rationale.push(
      `Selected '${chosen.name}' (confidence ${chosen.confidence.toFixed(2)}${
        chosen.parameterSize ? `, parameter size ${chosen.parameterSize}` : ""
      }) as the highest-confidence model in the registry.`,
    );
  }

  if (sorted.length > 1) {
    const others = sorted
      .filter((m) => m.name !== chosen?.name)
      .map((m) => `${m.name} (${m.confidence.toFixed(2)})`)
      .join(", ");
    rationale.push(`Considered: ${others}.`);
  }

  rationale.push(
    "Confidence starts from a parameter-size heuristic and is replaced by measured eval scores once `moss models --eval` records them for a model.",
  );

  return { task, chosen: chosen ?? null, considered: sorted, rationale };
}

export function formatRouteExplanationHuman(explanation: RouteExplanation): string {
  const lines: string[] = [];
  lines.push(`moss models --explain ${explanation.task}`);
  lines.push("");
  if (explanation.chosen) {
    lines.push(`Chosen: ${explanation.chosen.name}`);
  } else {
    lines.push("Chosen: (none — registry is empty)");
  }
  lines.push("");
  lines.push("Rationale:");
  for (const r of explanation.rationale) {
    lines.push(`  - ${r}`);
  }
  return lines.join("\n");
}
