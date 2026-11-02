import { joinInsideProject } from "../paths.ts";

export const USAGE_LOG_RELATIVE = "output/usage/usage.jsonl";

export function usageLogPath(): string {
  return joinInsideProject(USAGE_LOG_RELATIVE);
}
