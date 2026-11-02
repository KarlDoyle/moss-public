import { joinInsideProject } from "../paths.ts";

export const MEMORY_ROOT_RELATIVE = "output/memory";
export const MEMORY_ENTRIES_RELATIVE = "output/memory/entries";
export const MEMORY_SUMMARIES_RELATIVE = "output/memory/summaries";
export const MEMORY_AUDIT_RELATIVE = "output/memory/audit.jsonl";

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class MemoryPathInvalidError extends Error {
  constructor(label: string) {
    super(
      `'${label}' is not a safe memory path segment. Use alphanumeric characters, dots, underscores, or hyphens only.`,
    );
    this.name = "MemoryPathInvalidError";
  }
}

export function memoryRootPath(): string {
  return joinInsideProject(MEMORY_ROOT_RELATIVE);
}

export function memoryEntriesDir(): string {
  return joinInsideProject(MEMORY_ENTRIES_RELATIVE);
}

export function memoryEntryPath(id: string): string {
  assertSafeMemoryId(id);
  return joinInsideProject(`${MEMORY_ENTRIES_RELATIVE}/${id}.json`);
}

export function memorySummaryPath(name: string): string {
  assertSafeSummaryName(name);
  return joinInsideProject(`${MEMORY_SUMMARIES_RELATIVE}/${name}.md`);
}

export function memoryAuditPath(): string {
  return joinInsideProject(MEMORY_AUDIT_RELATIVE);
}

export function assertSafeMemoryId(id: string): void {
  if (!SAFE_NAME_RE.test(id)) {
    throw new MemoryPathInvalidError(id);
  }
}

export function assertSafeSummaryName(name: string): void {
  if (!SAFE_NAME_RE.test(name)) {
    throw new MemoryPathInvalidError(name);
  }
}

export function generateMemoryId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `mem-${stamp}-${suffix}`;
}
