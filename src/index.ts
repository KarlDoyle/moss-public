/**
 * moss — public library surface.
 *
 * Lets other tools use moss's deterministic provider routing directly, as a
 * library, instead of shelling out to the CLI. Standalone asks use this provider-order core; default sessions use
 * task-policy routing. These engines share pin and API eligibility controls. Re-exports only; no behaviour lives here, so the
 * safety boundaries (subprocess / network / git / reports) are unchanged.
 *
 * Example:
 *   import { routeAndGenerate } from "moss";
 *   const { result, explanation } = await routeAndGenerate("ask", { task: "ask", prompt, provider: "ollama", model: "llama3.1:latest" });
 */

// Routing — the core capability.
export {
  defaultRouterDependencies,
  explainProviderRoute,
  NoProviderAvailableError,
  type ProviderRouteExplanation,
  type RouterDependencies,
  routeAndGenerate,
  type UnavailableProviderEntry,
} from "./lib/providers/router.ts";

// Provider/task vocabulary + schemas for callers building requests.
export {
  PROVIDER_IDS,
  type ProviderCapabilities,
  type ProviderGenerateOptions,
  type ProviderGenerateResult,
  type ProviderId,
  ProviderIdSchema,
  type ProviderProbeResult,
  type ProviderStatus,
  TASK_IDS,
  type TaskId,
  TaskIdSchema,
} from "./lib/providers/types.ts";

// Registry — discover which models/providers are available on this host.
export { loadRegistry, type Registry } from "./lib/registry.ts";
