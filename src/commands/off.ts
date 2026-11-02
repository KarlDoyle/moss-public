// `moss off` — turn Ollama off now: unload every model, quit the Ollama app. Left alone if
// another moss or Aider is using it (`--force` overrides). The session and one-off commands
// do this themselves when they are done; this is the by-hand version.
import type { Command } from "commander";
import { turnOffOllama } from "../lib/ollama-lifecycle.ts";

export function registerOff(program: Command): void {
  program
    .command("off")
    .description(
      "Turn Ollama off now — unload its models and quit the app (moss starts it again on demand)",
    )
    .option("--force", "Even if another moss or Aider is running")
    .action(async (o: { force?: boolean }) => {
      const result = await turnOffOllama({ force: o.force === true });
      process.stdout.write(`${result.message}\n`);
      if (!result.off) process.exitCode = 1;
    });
}
