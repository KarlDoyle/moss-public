import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { MOSS_VERSION } from "../../version.ts";
import { memoryAuditPath } from "./paths.ts";
import { type MemoryAuditAction, type MemoryAuditEntry, MemoryAuditEntrySchema } from "./types.ts";

export interface MemoryAuditDeps {
  readonly appendFile: (path: string, data: string) => Promise<void>;
  readonly now: () => Date;
  readonly mossVersion: string;
}

export const defaultMemoryAuditDeps: MemoryAuditDeps = {
  appendFile: async (path, data) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, data, "utf8");
  },
  now: () => new Date(),
  mossVersion: MOSS_VERSION,
};

export async function writeMemoryAuditEntry(
  partial: {
    readonly action: MemoryAuditAction;
    readonly detail: string;
    readonly memoryId?: string;
  },
  deps: MemoryAuditDeps = defaultMemoryAuditDeps,
): Promise<MemoryAuditEntry> {
  const entry: MemoryAuditEntry = MemoryAuditEntrySchema.parse({
    schemaVersion: 1,
    timestamp: deps.now().toISOString(),
    action: partial.action,
    recordedBy: `moss@${deps.mossVersion}`,
    detail: partial.detail,
    ...(partial.memoryId ? { memoryId: partial.memoryId } : {}),
  });
  const line = `${JSON.stringify(entry)}\n`;
  await deps.appendFile(memoryAuditPath(), line);
  return entry;
}
