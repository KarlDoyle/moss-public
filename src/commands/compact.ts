import type { Command } from "commander";
import { compactMemoryByTag, MemoryCompactError } from "../lib/memory/compact.ts";
import { assertCapability } from "../lib/policy.ts";

export interface CompactCommandOptions {
  readonly tag: string;
  readonly outputName: string;
  readonly emitJson: boolean;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export async function runCompactCommand(options: CompactCommandOptions): Promise<number> {
  assertCapability("memory");

  try {
    const result = await compactMemoryByTag({
      tag: options.tag,
      outputName: options.outputName,
    });
    if (options.emitJson) {
      options.out(JSON.stringify({ ok: true, ...result }, null, 2));
    } else {
      options.out(
        `Compacted ${result.entryIds.length} entr${result.entryIds.length === 1 ? "y" : "ies"} to ${result.outputRelativePath}`,
      );
    }
    return 0;
  } catch (error) {
    const message =
      error instanceof MemoryCompactError || error instanceof Error ? error.message : String(error);
    options.err(`moss compact: ${message}`);
    return 1;
  }
}

export function registerCompact(program: Command): void {
  program
    .command("compact")
    .description(
      "Write a deterministic summary artifact for active entries with a tag. No LLM summarisation.",
    )
    .requiredOption("--tag <tag>", "Tag to compact")
    .requiredOption(
      "--output <name>",
      "Safe summary filename stem (alphanumeric, dot, underscore, hyphen)",
    )
    .action(async (commandOpts: { tag: string; output: string }) => {
      const globalOpts = program.opts<{ json?: boolean }>();
      const code = await runCompactCommand({
        tag: commandOpts.tag,
        outputName: commandOpts.output,
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
