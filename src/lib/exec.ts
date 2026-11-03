import { type Options as ExecaOptions, execa } from "execa";

export class ExecCommandNotAllowedError extends Error {
  constructor(command: string) {
    super(
      `Subprocess command '${command}' is not in the Moss allowlist. Allowlisted commands are configured in src/lib/exec.ts; add a deliberate entry there before invoking new binaries.`,
    );
    this.name = "ExecCommandNotAllowedError";
  }
}

export class ExecFailedError extends Error {
  public readonly command: string;
  public readonly args: readonly string[];
  public readonly exitCode: number | undefined;
  public readonly stdout: string;
  public readonly stderr: string;

  constructor(params: {
    command: string;
    args: readonly string[];
    exitCode: number | undefined;
    stdout: string;
    stderr: string;
  }) {
    super(
      `Subprocess '${params.command}' failed with exit code ${params.exitCode ?? "?"}. stderr: ${params.stderr.trim() || "(empty)"}`,
    );
    this.name = "ExecFailedError";
    this.command = params.command;
    this.args = params.args;
    this.exitCode = params.exitCode;
    this.stdout = params.stdout;
    this.stderr = params.stderr;
  }
}

// Least-privilege allowlist. Callers of each subprocess entry:
//   - pnpm: src/commands/doctor.ts (`checkBinary(deps, "pnpm", ["--version"])`)
//   - git:  src/lib/git.ts (safeGit wrapper, the only git invoker)
//   - gh:   src/commands/doctor.ts (`checkGithub`, `gh auth status`)
//   - ollama: the local Ollama lane currently talks to the daemon over HTTP
//     (src/lib/net.ts), so this entry is reserved for direct `ollama` CLI use
//     and is the only allowlisted command without a live subprocess caller.
//     `moss local` also starts the daemon (`ollama serve`) through runDetached.
//   - bash: src/lib/taisce/hooks.ts — runs Taisce's own session-start.sh and
//     front-door.sh hooks by path, so the session reuses the files instead of
//     copying them. Never given a `-c` string.
//   - claude: src/lib/providers/claude-code.ts — the subscription lane, `claude -p` with
//     every tool, hook, setting source, MCP server and slash command switched off.
//   - brew, softwareupdate, launchctl, npm: src/lib/health/ (`moss check`) — each admitted
//     only in its read-only form (ARG_RULES): `brew outdated`, `softwareupdate -l`,
//     `launchctl list`, `npm view`. Nothing installs, updates or loads anything.
//   - open, pkill, pgrep: src/lib/ollama-lifecycle.ts — `open -a Ollama`, `pkill -TERM -x
//     Ollama|ollama` (EXACT_ARGVS) and `pgrep -fl …`, and no other form.
//   - security: src/lib/providers/keychain.ts — reads the Anthropic API key from the macOS
//     Keychain. Only `security find-generic-password -w …` is accepted (ARG_RULES below):
//     a read of one item, never a write, a dump or a list.
// (`node` was removed: no production path ever spawned it.)
const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  "pnpm",
  "git",
  "gh",
  "ollama",
  "bash",
  "claude",
  "security",
  "brew",
  "softwareupdate",
  "launchctl",
  "npm",
  "open",
  "pgrep",
  "pkill",
]);

// Commands allowed only with a fixed leading argv. Checked in run() before spawning.
const ARG_RULES: Readonly<Record<string, readonly string[]>> = {
  security: ["find-generic-password", "-w"],
  brew: ["outdated"],
  softwareupdate: ["-l"],
  launchctl: ["list"],
  npm: ["view"],
  // Ollama on demand (src/lib/ollama-lifecycle.ts): start the app, quit the app, and see
  // whether another moss or Aider is using it. Exactly these, nothing else.
  pgrep: ["-fl"],
};

// Commands allowed ONLY as one of these whole argvs — nothing may be added or changed.
const EXACT_ARGVS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  open: [["-a", "Ollama"]],
  // SIGTERM to the Ollama app (it refuses an AppleScript quit) or a bare `ollama serve`.
  pkill: [
    ["-TERM", "-x", "Ollama"],
    ["-TERM", "-x", "ollama"],
  ],
};

function assertArgsAllowed(command: string, args: readonly string[]): void {
  const exact = EXACT_ARGVS[command];
  if (exact !== undefined) {
    if (!exact.some((argv) => argv.length === args.length && argv.every((a, i) => args[i] === a))) {
      throw new ExecCommandNotAllowedError(`${command} ${args.join(" ")}`);
    }
    return;
  }
  const lead = ARG_RULES[command];
  if (lead === undefined) return;
  if (lead.some((arg, i) => args[i] !== arg)) {
    throw new ExecCommandNotAllowedError(`${command} ${args.slice(0, lead.length).join(" ")}`);
  }
}

export interface ExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  // Variables to remove from the child's environment. execa extends process.env by
  // default, so a variable the parent was launched with (a git hook's GIT_DIR, say)
  // would otherwise reach the child and redirect it at the wrong repository.
  readonly unsetEnv?: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly allowFailure?: boolean;
  // Written to the child's stdin, then closed. Used by the Taisce hooks, which read their
  // event JSON from stdin. Absent → stdin is ignored (never inherited from the terminal).
  readonly input?: string;
}

export interface ExecResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function run(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new ExecCommandNotAllowedError(command);
  }
  assertArgsAllowed(command, args);

  const execaOptions: Record<string, unknown> = {
    timeout: options.timeoutMs ?? 60_000,
    reject: false,
    all: false,
    stripFinalNewline: false,
  };
  // Execa 10 rejects `signal`; subprocess cancellation uses `cancelSignal`.
  if (options.signal !== undefined) execaOptions.cancelSignal = options.signal;
  if (options.cwd !== undefined) {
    execaOptions.cwd = options.cwd;
  }
  if (options.env !== undefined || options.unsetEnv !== undefined) {
    // `undefined` entries are dropped by child_process.spawn, which is how a
    // variable is removed rather than merely blanked.
    const env: Record<string, string | undefined> = { ...options.env };
    for (const key of options.unsetEnv ?? []) {
      env[key] = undefined;
    }
    execaOptions.env = env;
  }
  if (options.input !== undefined) {
    execaOptions.input = options.input;
  } else {
    execaOptions.stdin = "ignore";
  }

  const result = await execa(command, [...args], execaOptions as ExecaOptions);
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : -1;

  if (!options.allowFailure && exitCode !== 0) {
    throw new ExecFailedError({
      command,
      args,
      exitCode,
      stdout,
      stderr,
    });
  }

  return {
    command,
    args,
    exitCode,
    stdout,
    stderr,
  };
}

// Detached execution is deliberately narrower than run(): only the local Ollama daemon
// may be started this way. Keep this exact argv aligned with ollama-lifecycle.ts.
export function runDetached(
  command: string,
  args: readonly string[],
  options: { readonly env?: Readonly<Record<string, string>> } = {},
): void {
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new ExecCommandNotAllowedError(command);
  }
  assertArgsAllowed(command, args);
  if (command !== "ollama" || args.length !== 1 || args[0] !== "serve") {
    throw new ExecCommandNotAllowedError(`${command} ${args.join(" ")}`);
  }
  const child = execa(command, [...args], {
    detached: true,
    stdio: "ignore",
    reject: false,
    ...(options.env !== undefined ? { env: options.env } : {}),
  } as ExecaOptions);
  // execa 10 dropped `unref` from its ResultPromise type; the underlying ChildProcess still
  // has it at runtime. Called through a structural type so execa 9 and 10 both compile.
  (child as unknown as { unref?: () => void }).unref?.();
  // A failed spawn must not crash moss; the caller re-probes the daemon instead.
  (child as unknown as Promise<unknown>).catch(() => undefined);
}

export function isCommandAllowed(command: string): boolean {
  return ALLOWED_COMMANDS.has(command);
}

export function listAllowedCommands(): string[] {
  return [...ALLOWED_COMMANDS].sort();
}
