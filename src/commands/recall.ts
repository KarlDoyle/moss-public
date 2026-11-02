import type { Command } from "commander";
import { recallMemory } from "../lib/memory/recall.ts";
import { assertCapability } from "../lib/policy.ts";

export interface RecallCommandOptions {
  readonly query?: string;
  readonly tag?: string;
  readonly emitJson: boolean;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export async function runRecallCommand(options: RecallCommandOptions): Promise<number> {
  assertCapability("memory");

  try {
    const result = await recallMemory({
      ...(options.query ? { query: options.query } : {}),
      ...(options.tag ? { tag: options.tag } : {}),
    });

    if (options.emitJson) {
      options.out(JSON.stringify(result, null, 2));
    } else if (result.count === 0) {
      options.out("No active memory entries matched.");
    } else {
      options.out(`Matched ${result.count} entr${result.count === 1 ? "y" : "ies"}:`);
      for (const entry of result.entries) {
        options.out(
          `  - ${entry.id} [${entry.type}/${entry.confidence}] tags=${entry.tags.join(",") || "(none)"}: ${entry.content}`,
        );
      }
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.err(`moss recall: ${message}`);
    return 1;
  }
}

export function registerRecall(program: Command): void {
  program
    .command("recall")
    .description(
      "List or search explicit local memory entries. Substring match only; no embeddings.",
    )
    .option("--query <text>", "Case-insensitive substring search over content and tags")
    .option("--tag <tag>", "Exact tag filter")
    .action(async (commandOpts: { query?: string; tag?: string }) => {
      const globalOpts = program.opts<{ json?: boolean }>();
      const code = await runRecallCommand({
        ...(commandOpts.query ? { query: commandOpts.query } : {}),
        ...(commandOpts.tag ? { tag: commandOpts.tag } : {}),
        emitJson: Boolean(globalOpts.json),
        out: (line) => {
          console.log(line);
        },
        err: (line) => {
          console.error(line);
        },
      });
      process.exitCode = code;
    });
}
