import { existsSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Command } from "commander";
import {
  buildEditPlanPrompt,
  defaultAiderRunner,
  parseEditPlan,
  pickFiles,
  runAiderConfined,
  tidyAiderOutput,
} from "../lib/aider.ts";
import { assertSafeGitConfig, gitDiffStat, gitTopLevel, gitTrackedFiles } from "../lib/git.ts";
import { defaultHealthCtx } from "../lib/health/context.ts";
import { renderReport, runChecks } from "../lib/health/runner.ts";
import { renderLaneChoice } from "../lib/lanes/explain.ts";
import { loadRoutingPolicy, taskForSkill } from "../lib/lanes/policy.ts";
import { defaultSelectDeps } from "../lib/lanes/runtime.ts";
import { selectLane } from "../lib/lanes/select.ts";
import { requestPins } from "../lib/lanes/skill-plan.ts";
import { assertChatModel, resolveCoderModel, resolveNumCtx } from "../lib/ollama.ts";
import { ollamaUse, turnOffOllama } from "../lib/ollama-lifecycle.ts";
import { assertTaiscePathReadable, getProjectRoot, resolveTaisceRoot } from "../lib/paths.ts";
import { PROVIDER_IDS, type ProviderId } from "../lib/providers/index.ts";
import { claudeModel } from "../lib/providers/metadata.ts";
import { bestModel, defaultRegistryDependencies, loadRegistry } from "../lib/registry.ts";
import { runFrontDoorHook, runSessionStartHook } from "../lib/taisce/hooks.ts";
import {
  buildTaisceSkillPrompt,
  defaultContextFor,
  findTaisceSkill,
  listLiveTaisceSkills,
  loadTaisceGuardrails,
  readGuardedTaisceFile,
} from "../lib/taisce/skills.ts";
import { recordUsageBestEffort } from "../lib/usage/log.ts";
import {
  type ChatGenerateParams,
  type ChatGenerateResult,
  type ChatSessionDeps,
  runChatSession,
  type SessionSkill,
} from "../repl/session.ts";
import { type AskCommandOptions, runAskCommand } from "./ask.ts";
import { applyPatch, claudeDiff, editRoute, routedGenerate, routeTable } from "./chat-lanes.ts";
import { allChecks } from "./check.ts";
import { defaultDoctorDependencies, gatherDiagnostics, runDoctorCommand } from "./doctor.ts";
import { formatLaneStatus, gatherLaneStatus } from "./lane-status.ts";

// Default model turn for the interactive session: delegate to the existing
// `runAskCommand` path so all routing, safety boundaries, and usage logging
// are inherited unchanged. Usage is logged as `command: "chat"` (D-0020).
// The response text is captured rather than printed directly so the session
// owns all output formatting.
export async function chatGenerate(params: ChatGenerateParams): Promise<ChatGenerateResult> {
  // Session pins stay on policy routing; context profiles and optional
  // manual/proxy lanes use ask with the same pin/API constraints.
  if (
    params.contextProfile === undefined &&
    params.provider !== "cursor-manual" &&
    params.provider !== "litellm"
  ) {
    return routedGenerate(params);
  }
  return legacyGenerate(params);
}

async function legacyGenerate(params: ChatGenerateParams): Promise<ChatGenerateResult> {
  // Never a reasoning model for chat — including when the registry picks one because
  // nothing else is installed. Resolve the default here so the check sees a real name.
  let model = params.model;
  let request = params;
  if (model === undefined && params.provider === undefined) {
    try {
      model = bestModel(await loadRegistry(defaultRegistryDependencies))?.name;
    } catch {
      model = undefined; // no registry: let the ask path report it
    }
  }
  if (model !== undefined) {
    try {
      assertChatModel(model);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    request = { ...params, model };
  }
  const captured: string[] = [];
  let lastError: string | undefined;

  const options: AskCommandOptions = {
    prompt: request.prompt,
    emitJson: false,
    out: (line) => captured.push(line),
    err: (line) => {
      lastError = line;
    },
    usageCommand: "chat",
    task: request.task === "reason" || request.task === "edit" ? "code-review" : "ask",
    ...(request.system !== undefined ? { system: request.system } : {}),
    recordUsage: (input) => recordUsageBestEffort(input),
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.provider !== undefined ? { provider: request.provider } : {}),
    ...(request.contextProfile !== undefined ? { karlContextProfile: request.contextProfile } : {}),
    ...(request.maxRequestBytes !== undefined ? { maxRequestBytes: request.maxRequestBytes } : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
  };

  const result = await runAskCommand(options);
  if (result.ok) {
    return {
      ok: true,
      response: captured.join("\n"),
      ...(result.model !== undefined ? { model: result.model } : {}),
      ...(result.warnings !== undefined ? { warnings: result.warnings } : {}),
    };
  }
  return { ok: false, error: result.error ?? lastError ?? "generation failed." };
}

// Read-only route explanation for the session's `/route` command.
// Mirrors `moss ask --explain`: uses the deterministic router, shrinking the
// lane list to the pinned provider when one is set, and returns the shared
// human-readable render. Probes are read-only (D-0009); nothing is executed.
export async function chatExplainRoute(
  provider: ProviderId | undefined,
  model?: string,
): Promise<string> {
  const choice = await selectLane(
    loadRoutingPolicy(),
    { task: "brief", promptTokens: 0, ...requestPins(model, provider) },
    defaultSelectDeps(),
  );
  return renderLaneChoice(
    choice,
    "moss chat — default brief route preview (prompt gates may change the route)",
  );
}

function parseProvider(value: string): ProviderId {
  if ((PROVIDER_IDS as readonly string[]).includes(value)) {
    return value as ProviderId;
  }
  throw new Error(`--provider must be one of: ${PROVIDER_IDS.join(", ")}; got '${value}'`);
}

// Everything the Taisce session needs, wired to the guarded helpers in src/lib. Kept as a
// function so a test can assert the wiring without starting readline.
export function buildTaisceSessionDeps(
  root: string = resolveTaisceRoot(),
): Omit<ChatSessionDeps, "lines" | "out" | "err" | "generate"> {
  const present = existsSync(root);
  const liveSkills = (): SessionSkill[] => (present ? listLiveTaisceSkills(root) : []);
  return {
    banner:
      "moss — Taisce session, local model. Ollama runs it and moss asks it. Optional Aider edits are unsupported. /help lists everything, /exit leaves.",
    brief: () => (present ? runSessionStartHook(root) : Promise.resolve(null)),
    frontDoor: (prompt) => (present ? runFrontDoorHook(prompt, root) : Promise.resolve(null)),
    guardrails: () => (present ? loadTaisceGuardrails(root) : null),
    skills: liveSkills,
    skillPrompt: (command, input) => {
      const skill = findTaisceSkill(command, root);
      if (skill === null) throw new Error(`no Taisce skill '${command}' under ${root}.`);
      const loaded = [skill.path.replace(`${root}/`, "")];
      const parts = [input];
      const contextFile = defaultContextFor(skill.id);
      if (contextFile !== undefined) {
        parts.push(readGuardedTaisceFile(contextFile, root));
        loaded.push(contextFile);
      }
      const guardrailsPresent = loadTaisceGuardrails(root) !== null;
      const joined = parts.filter((p) => p.trim().length > 0).join("\n\n");
      // Privacy rules go in the session header, not here, so they are never sent twice.
      let task: ReturnType<typeof taskForSkill> = "brief";
      try {
        task = taskForSkill(loadRoutingPolicy(), skill.id, skill.content);
      } catch {
        // no readable routing.yaml: the skill routes as a brief, which is always local
      }
      return {
        id: skill.id,
        body: buildTaisceSkillPrompt(skill, null, joined, { privacyCheck: guardrailsPresent }),
        loaded,
        task,
      };
    },
    readFile: (relPath) => readGuardedTaisceFile(relPath, root),
    status: async () => {
      const lines: string[] = [];
      await runDoctorCommand({ emitJson: false, out: (line) => lines.push(line) });
      lines.push("", formatLaneStatus(await gatherLaneStatus()));
      return lines.join("\n");
    },
    listModels: async () => {
      const report = await gatherDiagnostics(defaultDoctorDependencies);
      return report.ollama.models.map((m) => m.name);
    },
    checkModel: assertChatModel,
    isClaudeModel: (name) => claudeModel(name) !== undefined,
    routeTable: (pinned, provider) => routeTable(pinned, undefined, provider),
    check: async () => {
      const results = await runChecks(allChecks(), defaultHealthCtx(false));
      return renderReport(results, new Date());
    },
    numCtx: resolveNumCtx(),
    edit: {
      resolveRepo: async () => (await gitTopLevel(process.cwd())) ?? (present ? root : null),
      trackedFiles: (repo) => gitTrackedFiles(repo),
      checkFiles: (repo, files) => {
        // Inside Taisce, Aider may only be handed files guard-reads allows.
        if (realIfExists(repo) !== realIfExists(root)) return;
        for (const file of files) assertTaiscePathReadable(root, file);
      },
      coderModel: () => resolveCoderModel(),
      aider: async (repo, options) => {
        await assertSafeGitConfig(repo);
        const result = await runAiderConfined(
          repo,
          { ...options, model: options.model ?? resolveCoderModel() },
          defaultAiderRunner,
        );
        return { exitCode: result.exitCode, output: tidyAiderOutput(result.output) };
      },
      diffStat: (repo) => gitDiffStat(repo),
      buildPlanPrompt: buildEditPlanPrompt,
      parsePlan: parseEditPlan,
      pickFiles: (text, tracked) => pickFiles(text, tracked),
      route: async (ask, pinned, provider) =>
        editRoute(
          ask,
          pinned,
          present ? await runFrontDoorHook(ask, root) : null,
          undefined,
          provider,
        ),
      claudeDiff: (repo, plan, files, route) => claudeDiff(repo, plan, files, route),
      applyPatch: (repo, diff, check, files) => applyPatch(repo, diff, check, files),
    },
  };
}

function realIfExists(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

// The interactive session. `moss` with no arguments and `moss chat` both land here.
export async function startSession(
  commandOpts: { model?: string; provider?: ProviderId } = {},
): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "moss › ",
  });
  const controller = new AbortController();
  let terminationCode: number | undefined;
  // Piped input (a script, a test) can reach EOF while a model turn is still running;
  // prompting a closed interface throws, so the prompt is skipped once input has ended.
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  const deps: ChatSessionDeps = {
    lines: rl,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    prompt: () => {
      if (!closed) rl.prompt();
    },
    projectRoot: () => getProjectRoot(),
    generate: chatGenerate,
    signal: controller.signal,
    batchMode: process.stdin.isTTY !== true,
    onBatchFailure: () => {
      process.exitCode = 1;
    },
    explainRoute: chatExplainRoute,
    ...buildTaisceSessionDeps(),
    ...(commandOpts.model !== undefined ? { initialModel: commandOpts.model } : {}),
    ...(commandOpts.provider !== undefined ? { initialProvider: commandOpts.provider } : {}),
  };

  // Closing the session — /exit, Ctrl-D, or the terminal window (SIGHUP) — turns Ollama off
  // again if this session used it or started it, so nothing sits in memory afterwards.
  let ended = false;
  const endOllama = async (): Promise<void> => {
    if (ended) return;
    ended = true;
    if (!ollamaUse.used && !ollamaUse.started) return;
    const result = await turnOffOllama();
    process.stdout.write(`· ${result.message}\n`);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    terminationCode = 128 + (signal === "SIGINT" ? 2 : signal === "SIGHUP" ? 1 : 15);
    controller.abort(new Error(`chat interrupted by ${signal}`));
    rl.close();
  };
  const onSigint = (): void => onSignal("SIGINT");
  const onSighup = (): void => onSignal("SIGHUP");
  const onSigterm = (): void => onSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGHUP", onSighup);
  process.once("SIGTERM", onSigterm);
  try {
    await runChatSession(deps);
    if (terminationCode !== undefined) process.exitCode = terminationCode;
  } finally {
    rl.close();
    process.off("SIGINT", onSigint);
    process.off("SIGHUP", onSighup);
    process.off("SIGTERM", onSigterm);
    await endOllama();
  }
}

export function registerChat(program: Command): void {
  program
    .command("chat")
    .description("The session — brief, skills as /<name>, /edit, /model (same as `moss` alone)")
    .option("--model <name>", "Pin the session model (changeable with /model)")
    .option(
      "--provider <id>",
      "Pin the session provider lane (changeable with /provider)",
      parseProvider,
    )
    .action(async (commandOpts: { model?: string; provider?: ProviderId }) => {
      await startSession(commandOpts);
    });
}
