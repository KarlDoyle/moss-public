import type { Command } from "commander";
import { createMemoryEntry, updateMemoryEntry } from "../lib/memory/store.ts";
import {
  MEMORY_CONFIDENCE_LEVELS,
  MEMORY_TYPES,
  type MemoryConfidence,
  MemoryConfidenceSchema,
  type MemoryType,
  MemoryTypeSchema,
} from "../lib/memory/types.ts";
import { assertCapability } from "../lib/policy.ts";

const MEMORY_TYPE_EXAMPLE = "For release or milestone records, use --type fact --tag milestone.";

export interface RememberCommandOptions {
  readonly content?: string;
  readonly id?: string;
  readonly type?: string;
  readonly tags: readonly string[];
  readonly confidence?: string;
  readonly emitJson: boolean;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

function parseOptionalType(value: string | undefined): MemoryType | undefined {
  if (!value) return undefined;
  if (value === "milestone") return "fact";
  return MemoryTypeSchema.parse(value);
}

function parseOptionalConfidence(value: string | undefined): MemoryConfidence | undefined {
  if (!value) return undefined;
  return MemoryConfidenceSchema.parse(value);
}

export async function runRememberCommand(options: RememberCommandOptions): Promise<number> {
  assertCapability("memory");

  if (!options.content || options.content.trim().length === 0) {
    options.err(
      "moss remember: provide note text as the argument, or use --content with --id to update an entry.",
    );
    return 1;
  }

  try {
    const type = parseOptionalType(options.type);
    const confidence = parseOptionalConfidence(options.confidence);
    const entry = options.id
      ? await updateMemoryEntry({
          id: options.id,
          content: options.content,
          ...(type ? { type } : {}),
          ...(options.tags.length > 0 ? { tags: options.tags } : {}),
          ...(confidence ? { confidence } : {}),
        })
      : await createMemoryEntry({
          content: options.content,
          ...(type ? { type } : {}),
          ...(options.tags.length > 0 ? { tags: options.tags } : {}),
          ...(confidence ? { confidence } : {}),
        });

    if (options.emitJson) {
      options.out(JSON.stringify({ ok: true, entry }, null, 2));
    } else {
      options.out(`Remembered ${entry.id} (${entry.type}, ${entry.confidence})`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.emitJson) {
      options.err(
        JSON.stringify(
          {
            ok: false,
            error: message,
            validTypes: MEMORY_TYPES,
            example: MEMORY_TYPE_EXAMPLE,
          },
          null,
          2,
        ),
      );
    } else {
      options.err(
        `moss remember: ${message}\nValid memory types: ${MEMORY_TYPES.join(", ")}.\n${MEMORY_TYPE_EXAMPLE}`,
      );
    }
    return 1;
  }
}

export function registerRemember(program: Command): void {
  program
    .command("remember")
    .description("Store an explicit local memory entry. Opt-in only; never automatic.")
    .argument("[text]", "Note text to remember")
    .option("--id <id>", "Update an existing entry instead of creating one")
    .option("--content <text>", "New content when updating with --id")
    .option("--type <type>", `Memory type (${MEMORY_TYPES.join(", ")}; milestone aliases to fact)`)
    .option("--confidence <level>", `Confidence (${MEMORY_CONFIDENCE_LEVELS.join(", ")})`)
    .option("--tag <tag>", "Tag to attach (repeatable)", collectTags, [])
    .action(
      async (
        text: string | undefined,
        commandOpts: {
          id?: string;
          content?: string;
          type?: string;
          confidence?: string;
          tag?: string[];
        },
      ) => {
        const globalOpts = program.opts<{ json?: boolean }>();
        const content = commandOpts.content ?? text;
        const code = await runRememberCommand({
          ...(content ? { content } : {}),
          ...(commandOpts.id ? { id: commandOpts.id } : {}),
          ...(commandOpts.type ? { type: commandOpts.type } : {}),
          ...(commandOpts.confidence ? { confidence: commandOpts.confidence } : {}),
          tags: commandOpts.tag ?? [],
          emitJson: Boolean(globalOpts.json),
          out: (line) => {
            console.log(line);
          },
          err: (line) => {
            console.error(line);
          },
        });
        process.exitCode = code;
      },
    );
}

function collectTags(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export { MemoryStoreError } from "../lib/memory/store.ts";
