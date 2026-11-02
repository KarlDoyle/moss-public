// Renders a LaneChoice for `--explain`: the lane, the model, why (every lane considered,
// in order, with its reason), the estimated cost, and whether the result is stage-only.
import { getProviderMetadata } from "../providers/metadata.ts";
import type { LaneChoice } from "./select.ts";

function costLine(choice: LaneChoice): string {
  if (choice.lane === null || choice.estimate === null) return "nothing — no lane can run it";
  const e = choice.estimate;
  const tokens = `~${e.inputTokens.toLocaleString("en-GB")} in / ≤${e.outputTokens.toLocaleString("en-GB")} out tokens`;
  switch (getProviderMetadata(choice.lane).billing) {
    case "local":
      return `€0 (local) · ${tokens}`;
    case "sub":
      return e.usd === undefined
        ? `subscription (list-price estimate unknown) · ${tokens}`
        : `subscription (no per-call bill; ~$${e.usd.toFixed(4)} at API list price) · ${tokens}`;
    case "eur":
      return e.eur === undefined
        ? `metered cost unknown · ${tokens}`
        : `up to ~€${e.eur.toFixed(4)} (metered, counts toward the daily cap) · ${tokens}`;
    case "unknown":
      return `cost unknown (upstream billing is not measured) · ${tokens}`;
    case "manual":
      return `manual handoff, nothing called · ${tokens}`;
  }
}

export function renderLaneChoice(choice: LaneChoice, heading: string, context?: string): string {
  const lines = [heading];
  if (context !== undefined) lines.push(`  for:    ${context}`);
  lines.push(`  task:   ${choice.task}`);
  lines.push(
    choice.lane === null
      ? "  lane:   NONE — every lane in the list was skipped (reasons below)"
      : `  lane:   ${choice.lane} · ${choice.model}${choice.settings?.editor_model !== undefined ? ` (editor ${choice.settings.editor_model})` : ""}`,
  );
  lines.push("  why:");
  for (const v of choice.verdicts) {
    lines.push(`    ${v.picked ? "✓ picked " : "· skipped"} ${v.lane} — ${v.reason}`);
  }
  lines.push(`  cost:   ${costLine(choice)}`);
  lines.push(
    choice.stageOnly
      ? `  gate:   ${choice.gates.join(" + ")} — STAGE-ONLY: output shown; model input may be dispatched, proposed action not applied`
      : "  gate:   none",
  );
  return lines.join("\n");
}
