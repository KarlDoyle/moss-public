import { describe, expect, it } from "vitest";
import { formatLaneStatus, gatherLaneStatus } from "../../src/commands/lane-status.ts";

const now = new Date("2026-09-18T15:00:00");

describe("moss status — lanes", () => {
  it("shows each lane up or down, resident model, today's spend and the last bench", async () => {
    const s = await gatherLaneStatus({
      probe: async (id) =>
        id === "anthropic-api"
          ? { status: "not_configured", reason: "no API key." }
          : { status: "available", reason: "ok." },
      resident: async () => ["llama3.1:latest"],
      ledger: () => [
        {
          ts: now.toISOString(),
          lane: "anthropic-api",
          model: "sonnet",
          task: "reason",
          cost: "eur",
          eur: 0.4,
          by: "moss",
        },
        {
          ts: now.toISOString(),
          lane: "anthropic-api",
          model: "sonnet",
          task: "edit",
          cost: "eur",
          eur: 0.1,
          by: "moss",
        },
        {
          ts: now.toISOString(),
          lane: "ollama",
          model: "m",
          task: "brief",
          cost: "local",
          by: "moss",
        },
        {
          ts: "2026-09-01T10:00:00Z",
          lane: "claude-code",
          model: "sonnet",
          task: "reason",
          cost: "sub",
          by: "moss",
        },
      ],
      bench: () => [{ ts: "2026-09-18T10:00:00.000Z", by: "moss bench", ok: true }],
      now: () => now,
    });
    const text = formatLaneStatus(s);
    expect(text).toContain("ollama         up    ok.");
    expect(text).toContain("anthropic-api  down  no API key.");
    expect(text).toContain("resident model: llama3.1:latest");
    expect(text).toContain(
      "ollama 1 call (€0) · claude-code 0 calls (sub) · anthropic-api 2 calls (€0.50)",
    );
    expect(text).toContain("last bench:     2026-09-18 10:00 UTC, 1/1 models passed");
  });

  it("says when Ollama cannot be asked and bench never ran", async () => {
    const text = formatLaneStatus({ lanes: [], resident: null, today: [], bench: null });
    expect(text).toContain("unknown (Ollama not reachable)");
    expect(text).toContain("never — run `moss bench`");
    expect(formatLaneStatus({ lanes: [], resident: [], today: [], bench: null })).toContain(
      "none loaded",
    );
  });
});

describe("moss status — the tier comes from the lanes", () => {
  it("names the tier you are actually on", async () => {
    const { tierFromLanes } = await import("../../src/commands/estate.ts");
    const l = (claude: string, api: string, ollama: string) => [
      { id: "claude-code", status: claude },
      { id: "anthropic-api", status: api },
      { id: "ollama", status: ollama },
    ];
    expect(tierFromLanes(l("available", "disabled", "available"))).toMatch(/^Tier 0/);
    expect(tierFromLanes(l("unauthenticated", "available", "available"))).toMatch(/^Tier 2/);
    expect(tierFromLanes(l("unauthenticated", "disabled", "available"))).toBe(
      "Tier 3 — local (Ollama only)",
    );
    expect(tierFromLanes(l("unauthenticated", "disabled", "unavailable"))).toMatch(/^Tier 4/);
  });

  it("shows a switched-off lane as off, not down", () => {
    const text = formatLaneStatus({
      lanes: [{ id: "anthropic-api", status: "disabled", reason: "switched off in routing.yaml." }],
      resident: [],
      today: [],
      bench: null,
    });
    expect(text).toContain("anthropic-api  off   switched off in routing.yaml.");
  });
});
