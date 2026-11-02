import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { MOSS_VERSION } from "../version.ts";
import { ModelEvalsSchema } from "./evals/types.ts";
import { type FetchResult, safeFetch } from "./net.ts";
import { isReasoningModel } from "./ollama.ts";
import { joinInsideProject } from "./paths.ts";
import { PROVIDER_IDS } from "./providers/types.ts";

const REGISTRY_RELATIVE = "registry/models.json";
const OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags";

// `provider` is the closed M3 provider id union (D-0011, C-1).
// The enum is derived from the same `PROVIDER_IDS` constant the
// provider registry uses, so the schema cannot drift from the type
// system. Unknown provider strings are rejected at parse time.
// In M3-T01 only Ollama actually writes registry entries; the schema
// admits the others without forcing an implementation.
export const ModelEntrySchema = z.object({
  name: z.string().min(1),
  provider: z.enum(PROVIDER_IDS),
  parameterSize: z.string().optional(),
  quantization: z.string().optional(),
  family: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  confidence: z.number().min(0).max(1),
  // M4: optional eval results recorded by `moss models --eval`. Older
  // schemaVersion-1 registries without this field continue to parse
  // unchanged. When present, `confidence` and `aggregateScore` are
  // tied together: `confidence = aggregateScore` immediately after an
  // eval run, but operators can manually override `confidence` later
  // without losing the underlying eval history.
  evals: ModelEvalsSchema.optional(),
});

export const RegistrySchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  generatedBy: z.string(),
  source: z.string(),
  models: z.array(ModelEntrySchema),
});

export type ModelEntry = z.infer<typeof ModelEntrySchema>;
export type Registry = z.infer<typeof RegistrySchema>;

const OllamaTagSchema = z.object({
  name: z.string(),
  size: z.number().optional(),
  details: z
    .object({
      family: z.string().optional(),
      parameter_size: z.string().optional(),
      quantization_level: z.string().optional(),
    })
    .optional(),
});

const OllamaTagsResponseSchema = z.object({
  models: z.array(OllamaTagSchema).optional(),
});

export interface RegistryDependencies {
  readonly netFetch: (url: string) => Promise<FetchResult>;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
  readonly now: () => Date;
}

async function defaultReadFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function defaultWriteFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

export const defaultRegistryDependencies: RegistryDependencies = {
  netFetch: (url) => safeFetch(url, { timeoutMs: 5000 }),
  readFile: defaultReadFile,
  writeFile: defaultWriteFile,
  now: () => new Date(),
};

export function registryPath(): string {
  return joinInsideProject(REGISTRY_RELATIVE);
}

function parameterMajor(parameterSize: string | undefined): number | undefined {
  if (!parameterSize) return undefined;
  const match = parameterSize.match(/([0-9.]+)\s*B/i);
  if (!match?.[1]) return undefined;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function confidenceFor(parameterSize: string | undefined): number {
  const billions = parameterMajor(parameterSize);
  if (billions === undefined) return 0.5;
  if (billions <= 1) return 0.45;
  if (billions <= 3) return 0.75;
  if (billions <= 4) return 0.78;
  if (billions <= 8) return 0.7;
  if (billions <= 13) return 0.6;
  return 0.55;
}

function ollamaTagToEntry(raw: z.infer<typeof OllamaTagSchema>): ModelEntry {
  const parameterSize = raw.details?.parameter_size;
  const entry: Partial<ModelEntry> & Pick<ModelEntry, "name" | "provider" | "confidence"> = {
    name: raw.name,
    provider: "ollama",
    confidence: confidenceFor(parameterSize),
  };
  if (parameterSize !== undefined) entry.parameterSize = parameterSize;
  if (raw.details?.quantization_level !== undefined)
    entry.quantization = raw.details.quantization_level;
  if (raw.details?.family !== undefined) entry.family = raw.details.family;
  if (raw.size !== undefined) entry.bytes = raw.size;
  return entry as ModelEntry;
}

export async function refreshRegistry(
  deps: RegistryDependencies = defaultRegistryDependencies,
): Promise<Registry> {
  const response = await deps.netFetch(OLLAMA_TAGS_URL);
  if (!response.ok) {
    throw new Error(`Ollama tags endpoint returned HTTP ${response.status}`);
  }
  const parsed = OllamaTagsResponseSchema.parse(JSON.parse(response.body));
  const models = (parsed.models ?? []).map(ollamaTagToEntry);

  const registry: Registry = {
    schemaVersion: 1,
    generatedAt: deps.now().toISOString(),
    generatedBy: `moss@${MOSS_VERSION}`,
    source: OLLAMA_TAGS_URL,
    models,
  };

  await deps.writeFile(registryPath(), `${JSON.stringify(registry, null, 2)}\n`);
  return registry;
}

export class RegistryNotFoundError extends Error {
  constructor(path: string) {
    super(`Registry file not found at ${path}. Run \`moss models --refresh\` first.`);
    this.name = "RegistryNotFoundError";
  }
}

export class RegistryInvalidError extends Error {
  constructor(path: string, detail: string) {
    super(`Registry file at ${path} is malformed: ${detail}.`);
    this.name = "RegistryInvalidError";
  }
}

interface NodeError {
  code?: string;
}

function isNodeError(value: unknown): value is NodeError {
  return typeof value === "object" && value !== null && "code" in value;
}

export async function loadRegistry(
  deps: RegistryDependencies = defaultRegistryDependencies,
): Promise<Registry> {
  const path = registryPath();
  let raw: string;
  try {
    raw = await deps.readFile(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new RegistryNotFoundError(path);
    }
    throw error;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RegistryInvalidError(path, detail);
  }

  const result = RegistrySchema.safeParse(json);
  if (!result.success) {
    throw new RegistryInvalidError(path, result.error.message);
  }
  return result.data;
}

// Reasoning-model detection lives in src/lib/ollama.ts with the other Ollama safety
// defaults; re-exported here for existing importers.
export { isReasoningModel };

// Highest confidence wins, but a reasoning model is chosen only when nothing else is
// installed. Ties keep registry order.
export function bestModel(registry: Registry): ModelEntry | undefined {
  if (registry.models.length === 0) return undefined;
  const sorted = [...registry.models].sort((a, b) => {
    const ra = isReasoningModel(a.name) ? 1 : 0;
    const rb = isReasoningModel(b.name) ? 1 : 0;
    if (ra !== rb) return ra - rb;
    return b.confidence - a.confidence;
  });
  return sorted[0];
}

// M4: persist eval results into the registry. We rewrite the whole
// registry (it's small) so atomic file-replace semantics hold.
// `confidence` is updated to the eval aggregate; the prior heuristic-
// based confidence is overwritten because real measurements beat a
// parameter-size guess. The original `evals` field is replaced wholesale
// — we don't merge per-spec because new specs need to invalidate the
// rollup completely.
export async function applyEvalResults(
  modelName: string,
  evals: import("./evals/types.ts").ModelEvals,
  deps: RegistryDependencies = defaultRegistryDependencies,
): Promise<Registry> {
  const registry = await loadRegistry(deps);
  let found = false;
  const updatedModels = registry.models.map((entry) => {
    if (entry.name !== modelName) return entry;
    found = true;
    return { ...entry, confidence: evals.aggregateScore, evals };
  });
  if (!found) {
    throw new Error(
      `Cannot apply eval results: model '${modelName}' is not in the registry. Run \`moss models --refresh\` first.`,
    );
  }
  const next: Registry = {
    ...registry,
    generatedAt: deps.now().toISOString(),
    generatedBy: `moss@${MOSS_VERSION}`,
    models: updatedModels,
  };
  await deps.writeFile(registryPath(), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
