import type { Command } from "commander";
import { forgetMemoryEntry, MemoryNotFoundError, MemoryStoreError } from "../lib/memory/store.ts";
import { assertCapability } from "../lib/policy.ts";

export interface ForgetCommandOptions {
  readonly id: string;
  readonly emitJson: boolean;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export async function runForgetCommand(options: ForgetCommandOptions): Promise<number> {
  assertCapability("memory");

  try {
    const entry = await forgetMemoryEntry(options.id);
    if (options.emitJson) {
      options.out(JSON.stringify({ ok: true, entry }, null, 2));
    } else {
      options.out(`Forgot ${entry.id} (tombstoned; file retained for audit).`);
    }
    return 0;
  } catch (error) {
    const message =
      error instanceof MemoryNotFoundError ||
      error instanceof MemoryStoreError ||
      error instanceof Error
        ? error.message
        : String(error);
    options.err(`moss forget: ${message}`);
    return 1;
  }
}

export function registerForget(program: Command): void {
  program
    .command("forget")
    .description("Tombstone a memory entry so it is excluded from recall. Audited; file retained.")
    .argument("<id>", "Memory entry id")
    .action(async (id: string) => {
      const globalOpts = program.opts<{ json?: boolean }>();
      const code = await runForgetCommand({
        id,
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
