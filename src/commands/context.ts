import type { Command } from "commander";
import { loadKarlContextConfig, STARTER_KARL_CONTEXT_CONFIG } from "../lib/karl-context/config.ts";
import type { KarlContextReaderDeps } from "../lib/karl-context/reader.ts";
import { assembleContextPacket, defaultKarlContextReaderDeps } from "../lib/karl-context/reader.ts";

// `moss context` — read-only inspection of the bounded karl-context source.
// Modes: status (default) shows config + per-profile file counts/bytes;
// --print-config emits a starter config. Never mutates karl-context.

export interface ContextCommandOptions {
  readonly mode: "status" | "print-config";
  readonly emitJson: boolean;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  // Injected for tests; defaults to the real filesystem reader.
  readonly readerDeps?: KarlContextReaderDeps;
  // Injected for tests; defaults to loading config/karl-context.json.
  readonly loadConfig?: typeof loadKarlContextConfig;
}

export async function runContextCommand(options: ContextCommandOptions): Promise<number> {
  if (options.mode === "print-config") {
    options.out(STARTER_KARL_CONTEXT_CONFIG);
    return 0;
  }

  const load = options.loadConfig ?? loadKarlContextConfig;
  let config: Awaited<ReturnType<typeof loadKarlContextConfig>>;
  try {
    config = await load();
  } catch (error) {
    options.err(`moss context: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (config === null) {
    options.err(
      "No karl-context config at config/karl-context.json. Run `moss context --print-config > config/karl-context.json` and edit.",
    );
    return 1;
  }

  const profileNames = Object.keys(config.profiles).sort();

  // A disabled lane reports its config but reads nothing (default-off).
  if (!config.enabled) {
    if (options.emitJson) {
      options.out(
        JSON.stringify({ enabled: false, path: config.path, profiles: profileNames }, null, 2),
      );
    } else {
      options.out(
        "karl-context: disabled (set enabled: true in config/karl-context.json to use it).",
      );
      options.out(`path: ${config.path}`);
      options.out(`profiles: ${profileNames.join(", ") || "(none)"}`);
    }
    return 0;
  }

  const readerDeps = options.readerDeps ?? defaultKarlContextReaderDeps;
  const summaries: { profile: string; files: number; bytes: number; truncated: boolean }[] = [];
  for (const profile of profileNames) {
    const packet = await assembleContextPacket(config, profile, readerDeps);
    summaries.push({
      profile,
      files: packet.files.length,
      bytes: packet.totalBytes,
      truncated: packet.truncated,
    });
  }

  if (options.emitJson) {
    options.out(
      JSON.stringify(
        { enabled: true, path: config.path, maxBytes: config.maxBytes, profiles: summaries },
        null,
        2,
      ),
    );
  } else {
    options.out(`karl-context: enabled — ${config.path} (maxBytes ${config.maxBytes})`);
    for (const s of summaries) {
      options.out(
        `  ${s.profile}: ${s.files} file(s), ${s.bytes} bytes${s.truncated ? " (truncated)" : ""}`,
      );
    }
    options.out("Read-only. Moss never writes to karl-context (D-0024).");
  }
  return 0;
}

export function registerContext(program: Command): void {
  program
    .command("context")
    .description("Inspect the bounded karl-context source (read-only)")
    .option(
      "--print-config",
      "Print a starter config to stdout. Redirect to config/karl-context.json.",
    )
    .option("--json", "Emit JSON instead of human-readable text")
    .action(async (opts: { printConfig?: boolean; json?: boolean }) => {
      const code = await runContextCommand({
        mode: opts.printConfig === true ? "print-config" : "status",
        emitJson: opts.json === true,
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
      });
      if (code !== 0) process.exitCode = code;
    });
}
