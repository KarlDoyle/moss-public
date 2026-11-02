import { writeMemoryAuditEntry } from "./audit.ts";
import { listMemoryEntries } from "./store.ts";
import { type MemoryEntry, type RecallResult, RecallResultSchema } from "./types.ts";

export interface RecallOptions {
  readonly query?: string;
  readonly tag?: string;
}

function matchesQuery(entry: MemoryEntry, query: string): boolean {
  const needle = query.toLowerCase();
  if (entry.content.toLowerCase().includes(needle)) return true;
  return entry.tags.some((tag) => tag.toLowerCase().includes(needle));
}

function matchesTag(entry: MemoryEntry, tag: string): boolean {
  return entry.tags.includes(tag);
}

export async function recallMemory(options: RecallOptions = {}): Promise<RecallResult> {
  const all = await listMemoryEntries();
  let active = all.filter((entry) => entry.status === "active");

  if (options.tag) {
    active = active.filter((entry) => matchesTag(entry, options.tag as string));
  }
  if (options.query) {
    active = active.filter((entry) => matchesQuery(entry, options.query as string));
  }

  active.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const detailParts = [
    `matched=${active.length}`,
    options.query ? `query=${options.query}` : null,
    options.tag ? `tag=${options.tag}` : null,
  ].filter(Boolean);

  await writeMemoryAuditEntry({
    action: "recall",
    detail: detailParts.join(" "),
    ...(active[0]?.id ? { memoryId: active[0].id } : {}),
  });

  const result = RecallResultSchema.parse({
    ok: true,
    count: active.length,
    entries: active,
    ...(options.query ? { query: options.query } : {}),
    ...(options.tag ? { tag: options.tag } : {}),
  });
  return result;
}
