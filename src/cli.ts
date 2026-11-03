#!/usr/bin/env -S node --experimental-strip-types
import { Command } from "commander";
import { registerAsk } from "./commands/ask.ts";
import { registerAuth } from "./commands/auth.ts";
import { registerBench } from "./commands/bench.ts";
import { registerChat, startSession } from "./commands/chat.ts";
import { registerCheck } from "./commands/check.ts";
import { registerCompact } from "./commands/compact.ts";
import { registerContext } from "./commands/context.ts";
import { registerConvert } from "./commands/convert.ts";
import { registerCost } from "./commands/cost.ts";
import { registerDoctor } from "./commands/doctor.ts";
import { registerEstate } from "./commands/estate.ts";
import { explainInvocation } from "./commands/explain.ts";
import { registerForget } from "./commands/forget.ts";
import { registerInventory } from "./commands/inventory.ts";
import { registerLiteLlm } from "./commands/litellm.ts";
import { registerModels } from "./commands/models.ts";
import { registerOff } from "./commands/off.ts";
import { registerPlan } from "./commands/plan.ts";
import { registerRecall } from "./commands/recall.ts";
import { registerRemember } from "./commands/remember.ts";
import { registerRun } from "./commands/run.ts";
import { registerSkills } from "./commands/skills.ts";
import { registerTools } from "./commands/tools.ts";
import { enabledLocalhostEndpoint, loadLiteLlmConfig } from "./lib/litellm/config.ts";
import { enabledLocalhostEndpoints, loadMcpConfig } from "./lib/mcp/config.ts";
import { setLiteLlmEndpoint, setMcpEndpoints } from "./lib/net.ts";
import { MOSS_VERSION } from "./version.ts";

export interface BuildCliOptions {
  readonly exitOverride?: boolean;
  readonly registerCommands?: boolean;
  // List every command in --help, including the parked ones.
  readonly showAll?: boolean;
}

// Out-of-scope-and-slated features (README "Scope"), plus the pre-router provider views that
// `status`, `--explain` and `/model` now cover. Hidden from --help, never removed.
export const PARKED_COMMANDS: ReadonlySet<string> = new Set([
  "models",
  "auth",
  "skills",
  "plan",
  "litellm",
  "tools",
  "inventory",
  "context",
  "convert",
  "remember",
  "recall",
  "compact",
  "forget",
]);

// Commands whose own `--explain` means something else (a route preview with its own output
// shape): the global form only takes over for every other command.
const OWN_EXPLAIN = new Set(["ask", "models"]);

// `--explain` anywhere on the line → the global explain, minus the flag. Null = not asked.
export function globalExplainArgs(args: readonly string[]): string[] | null {
  const at = args.indexOf("--explain");
  if (at === -1) return null;
  if (at > 0 && OWN_EXPLAIN.has(args[0] ?? "")) return null;
  return [...args.slice(0, at), ...args.slice(at + 1)];
}

export function buildCli(options: BuildCliOptions = {}): Command {
  const program = new Command();
  program
    .name("moss")
    .description(
      "Moss — experimental local/hosted AI routing and approved text patches. Aider support is deprecated; local /edit is disabled. No arguments opens the session.",
    )
    .version(MOSS_VERSION, "-v, --version", "Print Moss version and exit")
    .option("--json", "Emit machine-readable JSON where supported")
    // `moss --explain <command …>` is handled in main() before commander parses, so it can
    // never shadow a subcommand's own --explain (ask, models). Listed here for --help only.
    .addHelpText(
      "after",
      '\n--explain on any command (moss run council "…" --explain): the lane, model, why and estimated cost — skips requested generation; probes/hooks may run',
    )
    .showHelpAfterError(true)
    .configureOutput({
      writeOut: (str) => process.stdout.write(str),
      writeErr: (str) => process.stderr.write(str),
    });

  if (options.registerCommands !== false) {
    // Everyday first — --help lists commands in registration order.
    registerChat(program);
    registerRun(program);
    registerAsk(program);
    registerEstate(program);
    registerCheck(program);
    registerCost(program);
    registerBench(program);
    registerDoctor(program);
    registerOff(program);
    registerModels(program);
    registerAuth(program);
    registerSkills(program);
    registerPlan(program);
    registerLiteLlm(program);
    registerTools(program);
    registerInventory(program);
    registerContext(program);
    registerConvert(program);
    registerRemember(program);
    registerRecall(program);
    registerCompact(program);
    registerForget(program);
  }

  // Parked features stay registered and working, but out of the default help so the everyday
  // surface is readable. `moss help --all` (or `moss --help --all`) lists everything.
  if (options.showAll !== true) {
    for (const cmd of program.commands) {
      if (PARKED_COMMANDS.has(cmd.name())) (cmd as unknown as { _hidden: boolean })._hidden = true;
    }
  }
  program.addHelpText(
    "after",
    options.showAll === true ? "" : "\nParked commands (still working): moss help --all",
  );

  if (options.exitOverride) {
    program.exitOverride();
  }

  return program;
}

// M5: install the LiteLLM endpoint into the net allowlist at session
// bootstrap. Pure read of `config/litellm.json`; if absent or disabled,
// no allowlist change is made and the M4 flow is preserved verbatim.
// Surfaced errors are non-fatal — a malformed config produces a
// `not_configured` probe in the lane, not a hard CLI crash.
export async function installLiteLlmSessionAllowlist(): Promise<void> {
  try {
    const config = await loadLiteLlmConfig();
    const endpoint = enabledLocalhostEndpoint(config);
    setLiteLlmEndpoint(endpoint);
  } catch {
    setLiteLlmEndpoint(null);
  }
}

export async function installMcpSessionAllowlist(): Promise<void> {
  try {
    const config = await loadMcpConfig();
    setMcpEndpoints(enabledLocalhostEndpoints(config));
  } catch {
    setMcpEndpoints([]);
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  await installLiteLlmSessionAllowlist();
  await installMcpSessionAllowlist();
  // `moss` with no arguments at all opens the interactive session. Decided here rather than
  // with a root commander action, so `moss <typo>` still gets commander's "unknown command".
  if (argv.length <= 2) {
    try {
      await startSession();
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`moss: ${message}\n`);
      return 1;
    }
  }
  // `moss --explain <command …>`: explain the route of any command and run nothing.
  const explained = globalExplainArgs(argv.slice(2));
  let commandIndex = 0;
  while (explained?.[commandIndex] === "--json") commandIndex++;
  const askPreview = explained !== null && explained[commandIndex] === "ask";
  if (explained !== null && !askPreview) {
    return explainInvocation(
      explained,
      (line) => process.stdout.write(`${line}\n`),
      (line) => process.stderr.write(`${line}\n`),
    );
  }
  // Global ask preview uses the same Commander parser/action as standalone ask.
  const invocation =
    askPreview && explained !== null
      ? [
          ...argv.slice(0, 2),
          ...explained.slice(0, commandIndex + 1),
          "--explain",
          ...explained.slice(commandIndex + 1),
        ]
      : argv;
  const rest = invocation.slice(2);
  const showAll = rest.includes("--all") && (rest[0] === "help" || rest.includes("--help"));
  const program = buildCli({ showAll });
  if (showAll && rest[0] === "help") {
    program.outputHelp();
    return 0;
  }
  try {
    await program.parseAsync([...invocation]);
    const code = process.exitCode;
    if (typeof code === "number") return code;
    if (typeof code === "string") {
      const parsed = Number.parseInt(code, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`moss: ${message}\n`);
    return 1;
  }
}

const isDirectInvocation = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return /\bcli\.ts$/.test(entry) || /\bmoss(\.js|\.ts)?$/.test(entry);
})();

if (isDirectInvocation) {
  // Exit quietly when a downstream reader closes the pipe early — e.g.
  // `moss ask --json | head` or piping into a pager. An unhandled EPIPE
  // on stdout/stderr otherwise crashes Node with an opaque stack instead
  // of a clean exit. Only installed for the real CLI process (not when
  // the module is imported by tests), so it cannot mask errors in-process.
  const handlePipeError = (err: NodeJS.ErrnoException): void => {
    if (err.code === "EPIPE") {
      process.exit(0);
    }
    throw err;
  };
  process.stdout.on("error", handlePipeError);
  process.stderr.on("error", handlePipeError);

  const exitCode = await main(process.argv);
  process.exit(exitCode);
}
