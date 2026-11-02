import type { Command } from "commander";
import { loadDocsConfig } from "../lib/docs/config.ts";
import {
  convertAllFromManifest,
  convertSinglePath,
  DocumentConvertError,
} from "../lib/docs/convert.ts";
import { assertCapability } from "../lib/policy.ts";

export interface ConvertCommandOptions {
  readonly mode: "single" | "all";
  readonly sourcePath?: string;
  readonly emitJson: boolean;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export async function runConvertCommand(options: ConvertCommandOptions): Promise<number> {
  assertCapability("documents");

  let config: Awaited<ReturnType<typeof loadDocsConfig>>;
  try {
    config = await loadDocsConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.err(`moss convert: ${message}`);
    return 1;
  }

  if (config === null) {
    options.err(
      "No document config at config/docs.json. Run `moss inventory --print-config > config/docs.json` and edit.",
    );
    return 1;
  }

  if (config.enabled !== true) {
    options.err("Document conversion is disabled. Set enabled:true in config/docs.json first.");
    return 1;
  }

  try {
    if (options.mode === "all") {
      const result = await convertAllFromManifest(config);
      if (options.emitJson) {
        options.out(JSON.stringify({ ok: true, ...result }, null, 2));
      } else {
        options.out(`Converted ${result.converted.length} file(s).`);
        for (const row of result.converted) {
          options.out(`  + ${row.sourceRelativePath} -> ${row.derivativeRelativePath}`);
        }
        if (result.skipped.length > 0) {
          options.out(`Skipped ${result.skipped.length} file(s):`);
          for (const row of result.skipped) {
            options.out(`  - ${row.sourceRelativePath}: ${row.reason}`);
          }
        }
      }
      return 0;
    }

    if (!options.sourcePath) {
      options.err("Specify --path <relative-path> or --all.");
      return 1;
    }

    const result = await convertSinglePath(config, options.sourcePath);
    if (options.emitJson) {
      options.out(JSON.stringify({ ok: true, ...result }, null, 2));
    } else {
      options.out(`Converted ${result.sourceRelativePath} -> ${result.derivativeRelativePath}`);
    }
    return 0;
  } catch (error) {
    const message =
      error instanceof DocumentConvertError || error instanceof Error
        ? error.message
        : String(error);
    options.err(`moss convert: ${message}`);
    return 1;
  }
}

export function registerConvert(program: Command): void {
  program
    .command("convert")
    .description(
      "Convert inventoried sources to markdown derivatives under output/ with provenance. No automatic moves.",
    )
    .option("--path <relative>", "Convert one inventoried file by relative path")
    .option("--all", "Convert all convertible files from the latest inventory manifest")
    .action(async (_opts, command) => {
      const parent = command.parent;
      const emitJson = parent?.opts().json === true;
      const opts = command.opts() as { path?: string; all?: boolean };
      const mode = opts.all === true ? "all" : "single";
      const code = await runConvertCommand({
        mode,
        ...(opts.path ? { sourcePath: opts.path } : {}),
        emitJson,
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
