import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { MOSS_VERSION } from "../../version.ts";
import { writeMemoryAuditEntry } from "./audit.ts";
import {
  assertSafeMemoryId,
  generateMemoryId,
  memoryEntriesDir,
  memoryEntryPath,
} from "./paths.ts";
import {
  type MemoryConfidence,
  type MemoryEntry,
  MemoryEntrySchema,
  type MemoryType,
} from "./types.ts";

export class MemoryStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryStoreError";
  }
}

export class MemoryNotFoundError extends Error {
  constructor(id: string) {
    super(`Memory entry '${id}' was not found. Run \`moss recall --json\` to list active entries.`);
    this.name = "MemoryNotFoundError";
  }
}

export interface MemoryStoreDeps {
  readonly readdir: typeof readdir;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly now: () => Date;
}

export const defaultMemoryStoreDeps: MemoryStoreDeps = {
  readdir,
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, contents) => writeFile(path, contents, "utf8"),
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  now: () => new Date(),
};

async function parseEntryFile(raw: string, label: string): Promise<MemoryEntry | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new MemoryStoreError(`Memory entry at ${label} is not valid JSON.`);
  }
  const result = MemoryEntrySchema.safeParse(parsed);
  if (!result.success) {
    throw new MemoryStoreError(
      `Memory entry at ${label} failed schema validation: ${result.error.message}`,
    );
  }
  return result.data;
}

export async function readMemoryEntry(
  id: string,
  deps: MemoryStoreDeps = defaultMemoryStoreDeps,
): Promise<MemoryEntry> {
  assertSafeMemoryId(id);
  const path = memoryEntryPath(id);
  try {
    const raw = await deps.readFile(path);
    const entry = await parseEntryFile(raw, path);
    if (!entry) throw new MemoryNotFoundError(id);
    return entry;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      throw new MemoryNotFoundError(id);
    }
    throw error;
  }
}

export async function listMemoryEntries(
  deps: MemoryStoreDeps = defaultMemoryStoreDeps,
): Promise<MemoryEntry[]> {
  const dir = memoryEntriesDir();
  await deps.mkdir(dir);
  let names: string[];
  try {
    names = await deps.readdir(dir);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  const entries: MemoryEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = `${dir}/${name}`;
    const raw = await deps.readFile(path);
    const entry = await parseEntryFile(raw, path);
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return entries;
}

async function persistEntry(entry: MemoryEntry, deps: MemoryStoreDeps): Promise<MemoryEntry> {
  const validated = MemoryEntrySchema.parse(entry);
  const path = memoryEntryPath(validated.id);
  await deps.mkdir(memoryEntriesDir());
  await deps.writeFile(path, `${JSON.stringify(validated, null, 2)}\n`);
  return validated;
}

export interface RememberInput {
  readonly content: string;
  readonly type?: MemoryType;
  readonly tags?: readonly string[];
  readonly confidence?: MemoryConfidence;
}

export async function createMemoryEntry(
  input: RememberInput,
  deps: MemoryStoreDeps = defaultMemoryStoreDeps,
): Promise<MemoryEntry> {
  const now = deps.now();
  const id = generateMemoryId(now);
  const entry: MemoryEntry = {
    schemaVersion: 1,
    id,
    content: input.content,
    type: input.type ?? "note",
    tags: input.tags ? [...input.tags] : [],
    source: {
      kind: "operator_cli",
      command: "remember",
      generatedBy: `moss-remember@${MOSS_VERSION}`,
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    confidence: input.confidence ?? "verified",
    status: "active",
    privacyLevel: "local",
  };
  const saved = await persistEntry(entry, deps);
  await writeMemoryAuditEntry({
    action: "remember",
    memoryId: saved.id,
    detail: `created type=${saved.type} tags=${saved.tags.join(",") || "(none)"}`,
  });
  return saved;
}

export interface UpdateMemoryInput {
  readonly id: string;
  readonly content: string;
  readonly type?: MemoryType;
  readonly tags?: readonly string[];
  readonly confidence?: MemoryConfidence;
}

export async function updateMemoryEntry(
  input: UpdateMemoryInput,
  deps: MemoryStoreDeps = defaultMemoryStoreDeps,
): Promise<MemoryEntry> {
  const existing = await readMemoryEntry(input.id, deps);
  if (existing.status === "forgotten") {
    throw new MemoryStoreError(
      `Memory entry '${input.id}' is forgotten. Create a new entry with \`moss remember\` instead.`,
    );
  }
  const now = deps.now();
  const updated: MemoryEntry = {
    ...existing,
    content: input.content,
    type: input.type ?? existing.type,
    tags: input.tags ? [...input.tags] : existing.tags,
    confidence: input.confidence ?? existing.confidence,
    updatedAt: now.toISOString(),
    source: {
      kind: "operator_cli",
      command: "remember",
      generatedBy: `moss-remember@${MOSS_VERSION}`,
    },
  };
  const saved = await persistEntry(updated, deps);
  await writeMemoryAuditEntry({
    action: "remember",
    memoryId: saved.id,
    detail: "updated content",
  });
  return saved;
}

export async function forgetMemoryEntry(
  id: string,
  deps: MemoryStoreDeps = defaultMemoryStoreDeps,
): Promise<MemoryEntry> {
  const existing = await readMemoryEntry(id, deps);
  if (existing.status === "forgotten") {
    throw new MemoryStoreError(`Memory entry '${id}' is already forgotten.`);
  }
  const updated: MemoryEntry = {
    ...existing,
    status: "forgotten",
    updatedAt: deps.now().toISOString(),
    source: {
      kind: "operator_cli",
      command: "forget",
      generatedBy: `moss-forget@${MOSS_VERSION}`,
    },
  };
  const saved = await persistEntry(updated, deps);
  await writeMemoryAuditEntry({
    action: "forget",
    memoryId: saved.id,
    detail: "tombstoned status=forgotten",
  });
  return saved;
}
