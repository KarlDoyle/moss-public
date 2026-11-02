import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  buildHandoffPacket,
  createCursorManualProvider,
  cursorManualGenerate,
  cursorManualProbe,
  cursorManualProvider,
  defaultCursorManualProviderDependencies,
  RECEIVING_AGENT_MUST_NOT_DO,
  RECEIVING_AGENT_SHOULD_DO,
  renderHandoffPrompt,
  SAFETY_BOUNDARIES,
} from "../../../src/lib/providers/cursor-manual.ts";
import { HandoffPacketSchema } from "../../../src/lib/providers/types.ts";

const FROZEN_NOW = new Date("2026-05-22T18:00:00.000Z");
const FIXED_DEPS = {
  now: () => FROZEN_NOW,
  mossVersion: "test-0.0.0",
};

describe("cursor-manual provider", () => {
  describe("probe", () => {
    it("always reports available — no auth, no network, no external CLI", async () => {
      const result = await cursorManualProbe(() => FROZEN_NOW);
      expect(result.id).toBe("cursor-manual");
      expect(result.status).toBe("available");
      expect(result.reason).toContain("no auth");
      expect(result.reason).toContain("no network");
      expect(result.capabilities.ask).toBe("available");
      expect(result.capabilities["code-review"]).toBe("available");
      expect(result.lastProbedAt).toBe(FROZEN_NOW.toISOString());
    });

    it("is deterministic — same now() yields byte-identical results", async () => {
      const a = await cursorManualProbe(() => FROZEN_NOW);
      const b = await cursorManualProbe(() => FROZEN_NOW);
      expect(a).toEqual(b);
    });
  });

  describe("buildHandoffPacket", () => {
    it("produces a packet matching the HandoffPacketSchema", () => {
      const packet = buildHandoffPacket(
        { task: "ask", prompt: "explain quicksort", model: "llama3.2:3b" },
        FIXED_DEPS,
      );
      expect(HandoffPacketSchema.safeParse(packet).success).toBe(true);
    });

    it("captures task, prompt, intendedLane, intendedModel, and provenance", () => {
      const packet = buildHandoffPacket({ task: "ask", prompt: "p", model: "m" }, FIXED_DEPS);
      expect(packet.schemaVersion).toBe("handoff_v1");
      expect(packet.task).toBe("ask");
      expect(packet.prompt).toBe("p");
      expect(packet.intendedLane).toBe("cursor-manual");
      expect(packet.intendedModel).toBe("m");
      expect(packet.provenance.generatedBy).toBe("moss@test-0.0.0");
      expect(packet.provenance.generatedAt).toBe(FROZEN_NOW.toISOString());
      expect(packet.provenance.lane).toBe("cursor-manual");
    });

    it("records intendedModel=null when the operator did not supply --model", () => {
      const packet = buildHandoffPacket({ task: "ask", prompt: "p" }, FIXED_DEPS);
      expect(packet.intendedModel).toBeNull();
    });

    it("propagates optional system and temperature when present", () => {
      const packet = buildHandoffPacket(
        { task: "code-review", prompt: "p", system: "s", temperature: 0.7 },
        FIXED_DEPS,
      );
      expect(packet.system).toBe("s");
      expect(packet.temperature).toBe(0.7);
    });

    it("omits system and temperature when not supplied", () => {
      const packet = buildHandoffPacket({ task: "ask", prompt: "p" }, FIXED_DEPS);
      expect("system" in packet).toBe(false);
      expect("temperature" in packet).toBe(false);
    });

    it("uses the canonical receiving-agent / safety boundary lists verbatim", () => {
      const packet = buildHandoffPacket({ task: "ask", prompt: "p" }, FIXED_DEPS);
      expect(packet.receivingAgentShouldDo).toEqual(RECEIVING_AGENT_SHOULD_DO);
      expect(packet.receivingAgentMustNotDo).toEqual(RECEIVING_AGENT_MUST_NOT_DO);
      expect(packet.safetyBoundaries).toEqual(SAFETY_BOUNDARIES);
    });
  });

  describe("renderHandoffPrompt", () => {
    it("contains the untrusted-input delimiter pair", () => {
      const packet = buildHandoffPacket({ task: "ask", prompt: "DANGER" }, FIXED_DEPS);
      const rendered = renderHandoffPrompt(packet);
      expect(rendered).toContain("UNTRUSTED_INPUT");
      expect(rendered).toContain("DANGER");
    });

    it("includes every receiving-agent rule and every safety boundary", () => {
      const packet = buildHandoffPacket({ task: "ask", prompt: "p" }, FIXED_DEPS);
      const rendered = renderHandoffPrompt(packet);
      for (const line of RECEIVING_AGENT_SHOULD_DO) expect(rendered).toContain(line);
      for (const line of RECEIVING_AGENT_MUST_NOT_DO) expect(rendered).toContain(line);
      for (const line of SAFETY_BOUNDARIES) expect(rendered).toContain(line);
    });

    it("never claims Moss executed the task", () => {
      const packet = buildHandoffPacket({ task: "ask", prompt: "p" }, FIXED_DEPS);
      const rendered = renderHandoffPrompt(packet);
      expect(rendered).toContain("Moss has NOT executed");
      expect(rendered.toLowerCase()).not.toContain("here is the answer");
      expect(rendered.toLowerCase()).not.toContain("moss answered");
    });

    it("includes provenance with moss version and timestamp", () => {
      const packet = buildHandoffPacket({ task: "ask", prompt: "p" }, FIXED_DEPS);
      const rendered = renderHandoffPrompt(packet);
      expect(rendered).toContain("Generated by: moss@test-0.0.0");
      expect(rendered).toContain(`Generated at: ${FROZEN_NOW.toISOString()}`);
    });

    it("explicitly notes when no intended model was supplied", () => {
      const packet = buildHandoffPacket({ task: "ask", prompt: "p" }, FIXED_DEPS);
      const rendered = renderHandoffPrompt(packet);
      expect(rendered).toContain("Intended model: (not specified");
    });
  });

  describe("cursorManualGenerate (Provider adapter)", () => {
    it("returns providerId='cursor-manual', a placeholder model, response, and the packet", async () => {
      const result = await cursorManualGenerate(
        { task: "ask", prompt: "hi", model: "llama3.2:3b" },
        FIXED_DEPS,
      );
      expect(result.providerId).toBe("cursor-manual");
      expect(result.model).toBe("(handoff)");
      expect(result.response).toContain("Moss handoff packet");
      expect(result.handoff).toBeDefined();
      expect(result.handoff?.prompt).toBe("hi");
      expect(result.handoff?.intendedModel).toBe("llama3.2:3b");
    });

    it("accepts a missing model (cursor-manual.requiresModel=false)", async () => {
      const result = await cursorManualGenerate({ task: "ask", prompt: "hi" }, FIXED_DEPS);
      expect(result.handoff?.intendedModel).toBeNull();
    });

    it("does not throw on any closed-union task", async () => {
      const ask = await cursorManualGenerate({ task: "ask", prompt: "p" }, FIXED_DEPS);
      const review = await cursorManualGenerate({ task: "code-review", prompt: "p" }, FIXED_DEPS);
      expect(ask.handoff?.task).toBe("ask");
      expect(review.handoff?.task).toBe("code-review");
    });
  });

  describe("Provider object", () => {
    it("declares executionType='manual_handoff' and requiresModel=false", () => {
      expect(cursorManualProvider.id).toBe("cursor-manual");
      expect(cursorManualProvider.executionType).toBe("manual_handoff");
      expect(cursorManualProvider.requiresModel).toBe(false);
      expect(typeof cursorManualProvider.probe).toBe("function");
      expect(typeof cursorManualProvider.generate).toBe("function");
    });

    it("createCursorManualProvider honours injected deps for both probe and generate", async () => {
      const provider = createCursorManualProvider(FIXED_DEPS);
      const probe = await provider.probe();
      expect(probe.lastProbedAt).toBe(FROZEN_NOW.toISOString());
      const gen = await provider.generate?.({ task: "ask", prompt: "p" });
      expect(gen?.handoff?.provenance.generatedAt).toBe(FROZEN_NOW.toISOString());
      expect(gen?.handoff?.provenance.generatedBy).toBe("moss@test-0.0.0");
    });

    it("module-level defaults use the real MOSS_VERSION (smoke check, no I/O)", () => {
      expect(typeof defaultCursorManualProviderDependencies.mossVersion).toBe("string");
      expect(defaultCursorManualProviderDependencies.mossVersion.length).toBeGreaterThan(0);
    });
  });

  describe("safety contract (static)", () => {
    function stripCommentsAndStrings(code: string): string {
      let out = code.replace(/\/\*[\s\S]*?\*\//g, "");
      out = out.replace(/^[ \t]*\/\/.*$/gm, "");
      out = out.replace(/(^|[^\\])'(?:[^'\\\n]|\\.)*'/g, "$1''");
      out = out.replace(/(^|[^\\])"(?:[^"\\\n]|\\.)*"/g, '$1""');
      let prev = "";
      while (prev !== out) {
        prev = out;
        out = out.replace(/`(?:\\.|[^`\\$]|\$(?!\{)|\$\{[^{}`]*\})*`/g, "``");
      }
      return out;
    }

    function loadSource(): string {
      const here = dirname(fileURLToPath(import.meta.url));
      const target = resolve(here, "../../../src/lib/providers/cursor-manual.ts");
      return readFileSync(target, "utf8");
    }

    it("imports no I/O surfaces (fs, child_process, net, https, http, os)", () => {
      const code = stripCommentsAndStrings(loadSource());
      for (const forbidden of [
        "node:fs",
        "node:child_process",
        "node:net",
        "node:https",
        "node:http",
        "node:os",
        "child_process",
        "fs/promises",
      ]) {
        expect(code, `forbidden import symbol present: ${forbidden}`).not.toContain(forbidden);
      }
    });

    it("calls no subprocess, fetch, or env-read APIs", () => {
      const code = stripCommentsAndStrings(loadSource());
      for (const forbidden of [
        "spawn",
        "execFile",
        "execSync",
        "spawnSync",
        "fetch(",
        "safeFetch",
        "process.env",
        "readFile",
        "writeFile",
        "homedir",
        "tmpdir",
      ]) {
        expect(code, `forbidden symbol present: ${forbidden}`).not.toContain(forbidden);
      }
    });

    it("does not reference Cursor auth/config/session file paths", () => {
      const code = stripCommentsAndStrings(loadSource());
      for (const forbidden of [
        "Application Support/Cursor",
        ".cursor",
        "cursor.json",
        "auth.json",
        "session.json",
        "keychain",
        "/Library/",
        "AppData",
      ]) {
        expect(code, `forbidden Cursor-path symbol: ${forbidden}`).not.toContain(forbidden);
      }
    });
  });

  describe("dispatch-time behaviour (no network)", () => {
    it("running probe and generate does not invoke global.fetch", async () => {
      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.fn(async () => {
        throw new Error("network was called");
      });
      // Overriding the global is intentional for this safety probe.
      // We cast through `unknown` so TypeScript doesn't insist on the
      // full DOM `fetch` signature; the spy refuses every call, which
      // is the point.
      (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;
      try {
        await cursorManualProbe(() => FROZEN_NOW);
        await cursorManualGenerate({ task: "ask", prompt: "p" }, FIXED_DEPS);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
      }
    });
  });
});
