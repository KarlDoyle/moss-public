import type { Command } from "commander";
import { loadDocsConfig, relativeApprovedPath, STARTER_DOCS_CONFIG } from "../lib/docs/config.ts";
import { runInventory } from "../lib/docs/inventory.ts";
import { loadReviewQueue } from "../lib/docs/review-queue.ts";
import { assertCapability } from "../lib/policy.ts";

export interface InventoryCommandOptions {
  readonly mode: "scan" | "print-config" | "check" | "review-queue";
  readonly emitJson: boolean;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export async function runInventoryCommand(options: InventoryCommandOptions): Promise<number> {
  assertCapability("documents");

  if (options.mode === "print-config") {
    options.out(STARTER_DOCS_CONFIG);
    return 0;
  }

  let config: Awaited<ReturnType<typeof loadDocsConfig>>;
  try {
    config = await loadDocsConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.err(`moss inventory: ${message}`);
    return 1;
  }

  if (config === null) {
    options.err(
      "No document config at config/docs.json. Run `moss inventory --print-config > config/docs.json` and edit.",
    );
    return 1;
  }

  if (options.mode === "check") {
    const summary = {
      enabled: config.enabled,
      approvedFolder: relativeApprovedPath(config),
      outputFolder: config.outputFolder,
      reviewQueuePath: config.reviewQueuePath,
    };
    if (options.emitJson) {
      options.out(JSON.stringify(summary, null, 2));
    } else {
      options.out(`Documents enabled: ${config.enabled}`);
      options.out(`Approved folder: ${summary.approvedFolder}`);
      options.out(`Output folder: ${summary.outputFolder}`);
      options.out(`Review queue: ${summary.reviewQueuePath}`);
    }
    return config.enabled ? 0 : 1;
  }

  if (options.mode === "review-queue") {
    const queue = await loadReviewQueue(config);
    if (options.emitJson) {
      options.out(JSON.stringify(queue, null, 2));
    } else {
      options.out(`Review queue (${queue.items.length} items):`);
      for (const item of queue.items) {
        options.out(
          `  - ${item.id}: ${item.sourceRelativePath} [${item.classification}] status=${item.status}`,
        );
      }
    }
    return 0;
  }

  if (config.enabled !== true) {
    options.err("Document inventory is disabled. Set enabled:true in config/docs.json first.");
    return 1;
  }

  try {
    const result = await runInventory(config);
    if (options.emitJson) {
      options.out(
        JSON.stringify(
          {
            ok: true,
            manifestRelativePath: result.manifestRelativePath,
            reviewQueueRelativePath: result.reviewQueueRelativePath,
            itemCount: result.manifest.items.length,
            items: result.manifest.items,
          },
          null,
          2,
        ),
      );
    } else {
      options.out(`Inventory complete: ${result.manifest.items.length} files`);
      options.out(`Manifest: ${result.manifestRelativePath}`);
      options.out(`Review queue: ${result.reviewQueueRelativePath}`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.err(`moss inventory: ${message}`);
    return 1;
  }
}

export function registerInventory(program: Command): void {
  program
    .command("inventory")
    .description(
      "Scan the configured approved folder (read-only) and write an inventory manifest plus review queue entries.",
    )
    .option("--print-config", "Print a starter config/docs.json to stdout")
    .option("--check", "Validate config/docs.json without scanning")
    .option("--review-queue", "Print the current review queue")
    .action(async (_opts, command) => {
      const parent = command.parent;
      const emitJson = parent?.opts().json === true;
      let mode: InventoryCommandOptions["mode"] = "scan";
      if (command.opts().printConfig === true) mode = "print-config";
      else if (command.opts().check === true) mode = "check";
      else if (command.opts().reviewQueue === true) mode = "review-queue";

      const code = await runInventoryCommand({
        mode,
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
