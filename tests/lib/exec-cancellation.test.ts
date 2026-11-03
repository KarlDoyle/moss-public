// Real Execa + Moss wrapper. The allowlisted bash entry execs a harmless Node
// fixture so its PID is the child under test; no production allowlist expansion.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ExecFailedError, run } from "../../src/lib/exec.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "moss-cancel-"));
  const ready = join(root, "ready");
  const child = join(root, "child.cjs");
  const launcher = join(root, "launch.sh");
  writeFileSync(
    child,
    'const fs = require("node:fs"); const ready = process.argv[2]; fs.writeFileSync(ready + ".tmp", String(process.pid)); fs.renameSync(ready + ".tmp", ready); setInterval(() => {}, 1000);',
  );
  writeFileSync(launcher, 'exec "$1" "$2" "$3"\n');
  return {
    ready,
    args: [launcher, process.execPath, child, ready],
    cleanup: () => {
      if (existsSync(ready)) {
        try {
          process.kill(Number(readFileSync(ready, "utf8")), "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("real subprocess cancellation", () => {
  it("terminates a started Node child promptly and reports ExecFailedError", async () => {
    const f = fixture();
    const controller = new AbortController();
    // Attach the rejection handler before aborting (and before startup assertions).
    const outcome = run("bash", f.args, {
      signal: controller.signal,
      timeoutMs: 6_000,
    }).catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(existsSync(f.ready)).toBe(true), { timeout: 3_000 });
      const pid = Number(readFileSync(f.ready, "utf8"));
      process.kill(pid, 0); // Handshake proves the real child started and is alive.
      const started = performance.now();
      controller.abort();
      const result = await outcome;
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(result).toBeInstanceOf(ExecFailedError);
      expect(result).toMatchObject({ command: "bash", exitCode: -1 });
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    } finally {
      controller.abort();
      f.cleanup();
      await outcome;
    }
  }, 10_000);

  it.each([false, true])(
    "handles an already-aborted signal (allowFailure=%s)",
    async (allowFailure) => {
      const f = fixture();
      const controller = new AbortController();
      controller.abort();
      try {
        const started = performance.now();
        const result = await run("bash", f.args, {
          signal: controller.signal,
          timeoutMs: 6_000,
          allowFailure,
        }).catch((error: unknown) => error);
        expect(performance.now() - started).toBeLessThan(2_000);
        if (allowFailure) {
          expect(result).not.toBeInstanceOf(Error);
          expect(result).toMatchObject({ exitCode: -1 });
        } else {
          expect(result).toBeInstanceOf(ExecFailedError);
          expect(result).toMatchObject({ exitCode: -1 });
        }
        if (existsSync(f.ready)) {
          const pid = Number(readFileSync(f.ready, "utf8"));
          expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
        }
      } finally {
        f.cleanup();
      }
    },
    10_000,
  );
});
