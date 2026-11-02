import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MOSS_VERSION } from "../../version.ts";
import { writeMemoryAuditEntry } from "./audit.ts";
import { memoryEntriesDir, memorySummaryPath } from "./paths.ts";
import { listMemoryEntries } from "./store.ts";

export class MemoryCompactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryCompactError";
  }
}

export interface CompactMemoryInput {
  readonly tag: string;
  readonly outputName: string;
}

export interface CompactMemoryDeps {
  readonly writeFile: (path: string, contents: string) => Promise<void>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly now: () => Date;
}

export const defaultCompactMemoryDeps: CompactMemoryDeps = {
  writeFile: (path, contents) => writeFile(path, contents, "utf8"),
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  now: () => new Date(),
};

export interface CompactMemoryResult {
  readonly outputRelativePath: string;
  readonly entryIds: readonly string[];
  readonly tag: string;
}

export async function compactMemoryByTag(
  input: CompactMemoryInput,
  deps: CompactMemoryDeps = defaultCompactMemoryDeps,
): Promise<CompactMemoryResult> {
  const all = await listMemoryEntries();
  const matches = all.filter(
    (entry) => entry.status === "active" && entry.tags.includes(input.tag),
  );
  if (matches.length === 0) {
    throw new MemoryCompactError(
      `No active memory entries found for tag '${input.tag}'. Add entries with \`moss remember --tag ${input.tag}\` first.`,
    );
  }

  const now = deps.now().toISOString();
  const entryIds = matches.map((entry) => entry.id);
  const bullets = matches
    .map((entry) => `- [${entry.id}] (${entry.type}, ${entry.confidence}) ${entry.content}`)
    .join("\n");

  const body = [
    "---",
    `generatedBy: "moss-compact@${MOSS_VERSION}"`,
    `createdAt: ${JSON.stringify(now)}`,
    `tag: ${JSON.stringify(input.tag)}`,
    `sourceEntryIds: ${JSON.stringify(entryIds)}`,
    `entryCount: ${matches.length}`,
    "---",
    "",
    `# Memory compact: ${input.tag}`,
    "",
    bullets,
    "",
  ].join("\n");

  const absolute = memorySummaryPath(input.outputName);
  await deps.mkdir(dirname(absolute));
  await deps.mkdir(memoryEntriesDir());
  await deps.writeFile(absolute, body);

  const outputRelativePath = `output/memory/summaries/${input.outputName}.md`;
  await writeMemoryAuditEntry({
    action: "compact",
    detail: `tag=${input.tag} output=${outputRelativePath} entries=${entryIds.length}`,
    ...(entryIds[0] ? { memoryId: entryIds[0] } : {}),
  });

  return { outputRelativePath, entryIds, tag: input.tag };
}
