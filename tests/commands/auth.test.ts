import { describe, expect, it } from "vitest";
import { runAuthCommand } from "../../src/commands/auth.ts";
import {
  allCapabilitiesAs,
  PROVIDER_ORDER,
  type Provider,
  type ProviderId,
  type ProviderProbeResult,
} from "../../src/lib/providers/index.ts";
import type { RouterDependencies } from "../../src/lib/providers/router.ts";

const FROZEN_NOW = () => new Date("2026-05-22T15:00:00.000Z");

function fakeProvider(opts: {
  id: ProviderId;
  status: ProviderProbeResult["status"];
  reason?: string;
  hasGenerate?: boolean;
  executionType?: Provider["executionType"];
}): Provider {
  const probe = async (now: () => Date = FROZEN_NOW): Promise<ProviderProbeResult> => ({
    id: opts.id,
    status: opts.status,
    reason: opts.reason ?? `${opts.id} probe → ${opts.status}`,
    capabilities: allCapabilitiesAs(opts.status),
    lastProbedAt: now().toISOString(),
  });
  const provider: Provider = {
    id: opts.id,
    executionType: opts.executionType ?? "local_dispatch",
    requiresModel: true,
    probe,
    ...(opts.hasGenerate === false
      ? {}
      : { generate: async () => ({ providerId: opts.id, model: "m", response: "r" }) }),
  };
  return provider;
}

function depsWithProviders(providers: Partial<Record<ProviderId, Provider>>): RouterDependencies {
  return {
    listProviders: () => PROVIDER_ORDER,
    getProvider: (id) => providers[id],
    now: FROZEN_NOW,
  };
}

describe("runAuthCommand", () => {
  describe("happy path — Ollama available, others not_installed", () => {
    it("returns ok=true and emits one row per provider id", async () => {
      const ollama = fakeProvider({ id: "ollama", status: "available", reason: "daemon up" });
      const out: string[] = [];
      const err: string[] = [];
      const result = await runAuthCommand({
        emitJson: false,
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        routerDeps: depsWithProviders({ ollama }),
      });
      expect(result.ok).toBe(true);
      expect(err).toEqual([]);
      const text = out.join("\n");
      // Every documented provider id appears in the rendered text.
      for (const id of PROVIDER_ORDER) {
        expect(text).toContain(id);
      }
      // The selected provider is marked with a `*`.
      expect(text).toMatch(/\* ollama/);
      // Read-only disclaimer present.
      expect(text).toContain("read-only");
      expect(text).toContain("does not read API keys");
    });

    it("the JSON shape carries selectedProvider, fallbackProviders, providers[], and probedAt", async () => {
      const ollama = fakeProvider({ id: "ollama", status: "available" });
      const out: string[] = [];
      const result = await runAuthCommand({
        emitJson: true,
        out: (l) => out.push(l),
        err: () => undefined,
        routerDeps: depsWithProviders({ ollama }),
      });
      expect(result.ok).toBe(true);
      const parsed = JSON.parse(out[0] ?? "{}");
      expect(parsed.ok).toBe(true);
      expect(parsed.task).toBe("ask");
      expect(parsed.probedAt).toBe("2026-05-22T15:00:00.000Z");
      expect(parsed.selectedProvider).toBe("ollama");
      expect(parsed.fallbackProviders).toEqual([]);
      expect(Array.isArray(parsed.providers)).toBe(true);
      expect(parsed.providers.length).toBe(PROVIDER_ORDER.length);
      const ollamaRow = parsed.providers.find((p: { id: string }) => p.id === "ollama");
      expect(ollamaRow.status).toBe("available");
      expect(ollamaRow.executionReadiness).toBe("generation-ready");
      expect(ollamaRow.isSelected).toBe(true);
      const litellmRow = parsed.providers.find((p: { id: string }) => p.id === "litellm");
      expect(litellmRow.status).toBe("not_installed");
      expect(litellmRow.isSelected).toBe(false);
    });
  });

  describe("no eligible provider", () => {
    it("emits ok=true with selectedProvider=null and a helpful hint", async () => {
      const ollamaDown = fakeProvider({
        id: "ollama",
        status: "unavailable",
        reason: "daemon not reachable at 127.0.0.1:11434",
      });
      const out: string[] = [];
      const result = await runAuthCommand({
        emitJson: false,
        out: (l) => out.push(l),
        err: () => undefined,
        routerDeps: depsWithProviders({ ollama: ollamaDown }),
      });
      expect(result.ok).toBe(true);
      const text = out.join("\n");
      expect(text).toContain("Selected provider: none");
      expect(text).toContain("daemon not reachable");
      expect(text).toMatch(/hint/i);
    });

    it("JSON view sets selectedProvider=null and fallbackProviders=[]", async () => {
      const ollamaDown = fakeProvider({ id: "ollama", status: "unavailable" });
      const out: string[] = [];
      const result = await runAuthCommand({
        emitJson: true,
        out: (l) => out.push(l),
        err: () => undefined,
        routerDeps: depsWithProviders({ ollama: ollamaDown }),
      });
      expect(result.ok).toBe(true);
      const parsed = JSON.parse(out[0] ?? "{}");
      expect(parsed.selectedProvider).toBeNull();
      expect(parsed.fallbackProviders).toEqual([]);
      const ollamaRow = parsed.providers.find((p: { id: string }) => p.id === "ollama");
      expect(ollamaRow.status).toBe("unavailable");
      expect(ollamaRow.isSelected).toBe(false);
    });
  });

  describe("fallback chain rendering", () => {
    it("shows the selected provider with `*` and lists fallback providers in order", async () => {
      const ollama = fakeProvider({ id: "ollama", status: "available", reason: "primary" });
      const anthropicApi = fakeProvider({
        id: "anthropic-api",
        status: "available",
        reason: "secondary",
      });
      const litellm = fakeProvider({ id: "litellm", status: "available", reason: "tertiary" });
      const out: string[] = [];
      const result = await runAuthCommand({
        emitJson: false,
        out: (l) => out.push(l),
        err: () => undefined,
        routerDeps: depsWithProviders({ ollama, "anthropic-api": anthropicApi, litellm }),
      });
      expect(result.ok).toBe(true);
      const text = out.join("\n");
      expect(text).toMatch(/\* ollama/);
      // anthropic-api and litellm appear without `*` but as fallback rows.
      expect(text).toMatch(/ {2}anthropic-api/);
      expect(text).toMatch(/ {2}litellm/);
      expect(text).toContain("Fallback chain: anthropic-api -> litellm");
    });
  });

  describe("provider readiness wording", () => {
    // NOTE (unified router): the closed lane set no longer contains any
    // genuinely detection-only id — every one of the five real
    // implementations wires `generate()`. Injecting a fake provider with no
    // `generate` still excludes it from selection/fallback and still
    // surfaces the router's "detection-only" REASON honestly (both asserted
    // below), but `explain-render.ts`'s `executionTypeFor` picks the
    // human-readable execution-readiness LABEL from a hardcoded per-id
    // switch rather than from the injected provider's own declared
    // executionType, so a fake like this still renders as
    // "generation-ready" for the label. That mismatch is unreachable in
    // production today (no real lane is both `available` and generate-less)
    // — flagged separately rather than fixed here, since fixing it means
    // touching src/lib/providers/explain-render.ts.
    it("never selects or falls back to a lane whose generate() is missing, and explains why", async () => {
      const ollama = fakeProvider({ id: "ollama", status: "unavailable" });
      const litellm = fakeProvider({
        id: "litellm",
        status: "available",
        reason: "litellm detected",
        hasGenerate: false,
        executionType: "detection_only",
      });
      const out: string[] = [];
      const result = await runAuthCommand({
        emitJson: false,
        out: (line) => out.push(line),
        err: () => undefined,
        routerDeps: depsWithProviders({ ollama, litellm }),
      });
      expect(result.ok).toBe(true);
      const text = out.join("\n");
      expect(text).toContain("litellm");
      expect(text).toContain(
        "Lane is detection-only in this build — no generate() implementation.",
      );
      expect(text).not.toMatch(/\* litellm/);
    });

    it("JSON marks manual handoff explicitly and never selects a generate-less lane", async () => {
      const ollama = fakeProvider({ id: "ollama", status: "unavailable" });
      const cursor = fakeProvider({
        id: "cursor-manual",
        status: "available",
        executionType: "manual_handoff",
      });
      const litellm = fakeProvider({
        id: "litellm",
        status: "available",
        hasGenerate: false,
        executionType: "detection_only",
      });
      const out: string[] = [];
      await runAuthCommand({
        emitJson: true,
        out: (line) => out.push(line),
        err: () => undefined,
        routerDeps: depsWithProviders({ ollama, "cursor-manual": cursor, litellm }),
      });
      const parsed = JSON.parse(out[0] ?? "{}");
      const cursorRow = parsed.providers.find((p: { id: string }) => p.id === "cursor-manual");
      const litellmRow = parsed.providers.find((p: { id: string }) => p.id === "litellm");
      expect(cursorRow.executionReadiness).toBe("manual handoff");
      expect(cursorRow.isSelected).toBe(true);
      expect(litellmRow.isSelected).toBe(false);
      expect(litellmRow.reason).toContain("detection-only in this build");
    });
  });

  describe("read-only safety contract", () => {
    it("the implementation does not import any subprocess, fs-write, or credential-reading symbol", async () => {
      // Static contract check against the source. The test reads the
      // module file, strips line/block comments AND string-literal
      // payloads (single, double, template) including the interior
      // of template-literal `${…}` interpolations so a future
      // `${execSync(…)}` can't slip past the scan by hiding inside a
      // template, then asserts none of the disallowed shapes appear
      // in the remaining executable surface. Defence in depth on top
      // of the safety-auditor's behavioural review.
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(new URL("../../src/commands/auth.ts", import.meta.url), "utf8");

      // Strip comments first so subsequent string-removal passes see
      // the same shape the runtime sees.
      let code = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

      // Iteratively strip template literals from innermost outward.
      // Each pass removes any backtick-quoted block whose body
      // contains no further `${`, then loops until no template
      // literals remain. This handles arbitrary interpolation nesting
      // and ensures the interior of every `${...}` is also stripped
      // (because the outermost stripped template will have already
      // had its inner template fully consumed by a prior pass).
      for (let i = 0; i < 16; i += 1) {
        const before = code;
        code = code.replace(/`[^`]*`/g, "``");
        if (code === before) break;
      }

      // Now strip single- and double-quoted strings. Order matters:
      // template literals come first because they can contain `'` or
      // `"` as ordinary characters.
      code = code.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");

      // Broad guards — these subsume the per-vendor enumeration the
      // earlier draft used. `auth.ts` legitimately needs none of
      // these, so a blanket guard is tighter and harder to bypass
      // than an exhaustive list.
      const forbiddenBroad = [
        "process.env", // covers every credential env-var name
        "child_process",
        ".env",
        ".ssh",
        ".zshrc",
        ".bashrc",
        ".bash_profile",
        ".zprofile",
        ".profile",
        ".zshenv",
        "config.fish",
        "keychain",
        "inquirer",
        "readline",
        "dotenv",
      ];
      const forbiddenShapes = [
        "execa",
        "spawn(",
        "exec(",
        "execFile(",
        "execSync(",
        "spawnSync(",
        "writeFile",
        "writeFileSync",
        "appendFile",
        "appendFileSync",
        "openSync(",
        "createWriteStream(",
        "copyFile",
        "copyFileSync",
        "rename(",
        "renameSync(",
        "symlink(",
        "symlinkSync(",
        "link(",
        "linkSync(",
        "id_rsa",
        "id_ed25519",
      ];
      for (const symbol of [...forbiddenBroad, ...forbiddenShapes]) {
        expect(code, `auth.ts code must not reference '${symbol}'`).not.toContain(symbol);
      }
    });

    it("the runAuthCommand call does not invoke any forbidden side effect when probes are stubbed", async () => {
      // Behavioural check: even with the simplest possible router
      // deps (a single available Ollama probe that does nothing
      // observable), runAuthCommand must complete without writing to
      // stderr unless the probe itself failed. Combined with the
      // static check above, this gives us reasonable confidence the
      // command is side-effect-free in the operator's environment.
      const ollama = fakeProvider({ id: "ollama", status: "available" });
      const err: string[] = [];
      const result = await runAuthCommand({
        emitJson: true,
        out: () => undefined,
        err: (l) => err.push(l),
        routerDeps: depsWithProviders({ ollama }),
      });
      expect(result.ok).toBe(true);
      expect(err).toEqual([]);
    });
  });

  describe("determinism", () => {
    it("repeated calls with the same router deps produce identical output", async () => {
      const ollama = fakeProvider({ id: "ollama", status: "available" });
      const aOut: string[] = [];
      const bOut: string[] = [];
      await runAuthCommand({
        emitJson: true,
        out: (l) => aOut.push(l),
        err: () => undefined,
        routerDeps: depsWithProviders({ ollama }),
      });
      await runAuthCommand({
        emitJson: true,
        out: (l) => bOut.push(l),
        err: () => undefined,
        routerDeps: depsWithProviders({ ollama }),
      });
      expect(aOut).toEqual(bOut);
    });
  });
});
