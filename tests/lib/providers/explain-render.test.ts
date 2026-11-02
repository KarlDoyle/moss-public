import { describe, expect, it } from "vitest";
import { READ_ONLY_FOOTER } from "../../../src/commands/auth.ts";
import {
  formatRouteExplanationHuman,
  formatRouteExplanationJson,
  rowsFromExplanation,
} from "../../../src/lib/providers/explain-render.ts";
import { PROVIDER_ORDER } from "../../../src/lib/providers/index.ts";
import type { ProviderRouteExplanation } from "../../../src/lib/providers/router.ts";

const PROBED_AT = "2026-05-22T15:00:00.000Z";

function baseExplanation(): ProviderRouteExplanation {
  return {
    task: "ask",
    selectedProvider: "ollama",
    selectedReason: "ollama probe → available",
    selectedExecutionType: "local_dispatch",
    fallbackProviders: [],
    unavailableProviders: PROVIDER_ORDER.filter((id) => id !== "ollama").map((id) => ({
      id,
      status: "not_installed",
      reason: `No Moss provider implementation registered for lane '${id}' in this build.`,
    })),
    unknownCapabilities: [],
    probedAt: PROBED_AT,
  };
}

describe("explain-render", () => {
  it("rowsFromExplanation produces one row per PROVIDER_ORDER entry, in that order", () => {
    const rows = rowsFromExplanation(baseExplanation());
    expect(rows.map((r) => r.id)).toEqual([...PROVIDER_ORDER]);
    const selected = rows.find((r) => r.id === "ollama");
    expect(selected?.isSelected).toBe(true);
    expect(selected?.status).toBe("available");
  });

  it("rowsFromExplanation marks fallbacks as available with a clear reason", () => {
    const explanation: ProviderRouteExplanation = {
      ...baseExplanation(),
      selectedProvider: "ollama",
      fallbackProviders: ["anthropic-api"],
      unavailableProviders: PROVIDER_ORDER.filter(
        (id) => id !== "ollama" && id !== "anthropic-api",
      ).map((id) => ({
        id,
        status: "not_installed",
        reason: `No Moss provider implementation registered for lane '${id}' in this build.`,
      })),
    };
    const rows = rowsFromExplanation(explanation);
    const fallback = rows.find((r) => r.id === "anthropic-api");
    expect(fallback?.isSelected).toBe(false);
    expect(fallback?.status).toBe("available");
    expect(fallback?.executionReadiness).toContain("remote dispatch");
    expect(fallback?.reason).toContain("Eligible fallback");
  });

  it("formatRouteExplanationHuman embeds the supplied heading and footer", () => {
    const text = formatRouteExplanationHuman(baseExplanation(), {
      heading: "Custom heading",
      footer: "Custom footer",
    });
    expect(text.startsWith("Custom heading")).toBe(true);
    expect(text.endsWith("Custom footer")).toBe(true);
    expect(text).toContain("Selected provider: ollama");
  });

  it("formatRouteExplanationHuman omits the footer line when no footer is supplied", () => {
    const text = formatRouteExplanationHuman(baseExplanation(), { heading: "H" });
    expect(text).not.toContain("Custom footer");
    // The last non-empty line should be either the selected/fallback
    // line or the unknown-capabilities line — never a footer.
    const lastLine = text
      .split("\n")
      .filter((l) => l.length > 0)
      .pop();
    expect(lastLine).toBeDefined();
    expect(lastLine).not.toMatch(/^moss /);
  });

  it("formatRouteExplanationJson exposes a stable, documented shape", () => {
    const body = formatRouteExplanationJson(baseExplanation());
    expect(Object.keys(body).sort()).toEqual(
      [
        "task",
        "probedAt",
        "selectedProvider",
        "selectedExecutionType",
        "fallbackProviders",
        "unknownCapabilities",
        "providers",
      ].sort(),
    );
    expect(body.providers.map((r) => r.id)).toEqual([...PROVIDER_ORDER]);
    expect(body.selectedExecutionType).toBe("local_dispatch");
    expect(body.providers[0]?.executionReadiness).toBe("generation-ready");
    // M11 (T2): each provider row carries declarative metadata in the JSON.
    const first = body.providers[0];
    expect(first?.metadata).toBeDefined();
    expect(first?.metadata.billing).toBe("local"); // ollama
    expect(typeof first?.metadata.offlineSupport).toBe("boolean");
  });

  it("byte-identical body between auth and ask --explain rendering for the same explanation", () => {
    // This is the invariant that lets us share one renderer: the
    // body between heading and footer must match exactly. We assert
    // it by stripping the heading line and the footer line from the
    // 'auth' rendering and comparing to the same slice of the
    // 'ask --explain' rendering.
    const explanation = baseExplanation();
    const authText = formatRouteExplanationHuman(explanation, {
      heading: "Moss provider status",
      footer: READ_ONLY_FOOTER,
    });
    const askText = formatRouteExplanationHuman(explanation, {
      heading: "moss ask — route preview",
    });
    const stripFirstLine = (s: string) => s.split("\n").slice(1).join("\n");
    const stripTrailingFooter = (s: string) => {
      // The footer is preceded by a blank line; if it isn't present
      // (e.g. wording drifted), throw rather than silently no-op.
      const marker = `\n\n${READ_ONLY_FOOTER}`;
      const idx = s.lastIndexOf(marker);
      if (idx === -1) {
        throw new Error(
          "Auth-rendered text did not contain the expected footer block; renderer drift?",
        );
      }
      return s.slice(0, idx);
    };
    expect(stripTrailingFooter(stripFirstLine(authText))).toBe(stripFirstLine(askText));
  });
});
