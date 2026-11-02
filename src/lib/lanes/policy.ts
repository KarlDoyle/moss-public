// config/routing.yaml — loaded, validated, and asked questions of. Pure apart from the read.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { joinInsideProject } from "../paths.ts";
import { LANE_TASK_TYPES, type LaneTaskType } from "../providers/metadata.ts";
import { PROVIDER_IDS, type ProviderId } from "../providers/types.ts";

const LaneId = z.enum(PROVIDER_IDS);
const TaskType = z.enum(LANE_TASK_TYPES);

export const LaneSettingsSchema = z
  .object({
    model: z.string().min(1),
    editor_model: z.string().min(1).optional(),
    num_ctx: z.number().int().positive().optional(),
    num_predict: z.number().int().positive().optional(),
    max_tokens: z.number().int().positive().optional(),
  })
  .strict();
export type LaneSettings = z.infer<typeof LaneSettingsSchema>;

const TaskRowSchema = z
  .object({ lanes: z.array(LaneId).min(1) })
  .catchall(LaneSettingsSchema)
  .superRefine((row, ctx) => {
    for (const lane of row.lanes) {
      if (!(lane in row))
        ctx.addIssue({ code: "custom", message: `lane ${lane} is listed but has no settings` });
    }
  });

export const RoutingPolicySchema = z.object({
  last_reviewed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  review_frequency: z.string(),
  tasks: z.record(TaskType, TaskRowSchema),
  caps: z.object({
    // `enabled` defaults to false: the metered lane is opt-in, never on by accident.
    "anthropic-api": z.object({
      enabled: z.boolean().default(false),
      daily_eur: z.number().nonnegative(),
    }),
    "claude-code": z.object({ sonnet_first: z.boolean() }),
  }),
  fx: z.object({ usd_to_eur: z.number().positive(), checked: z.string() }),
  stakes: z.object({ gates: z.array(z.string()).min(1), best_order: z.array(LaneId).min(1) }),
  skills: z.record(z.string(), TaskType),
});
export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;

export const ROUTING_FILE = "config/routing.yaml";

export function loadRoutingPolicy(path: string = joinInsideProject(ROUTING_FILE)): RoutingPolicy {
  const parsed = RoutingPolicySchema.safeParse(parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(
      `${ROUTING_FILE} is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  for (const task of LANE_TASK_TYPES) {
    if (parsed.data.tasks[task] === undefined)
      throw new Error(`${ROUTING_FILE} has no row for task '${task}'`);
  }
  return parsed.data;
}

export function lanesFor(policy: RoutingPolicy, task: LaneTaskType): readonly ProviderId[] {
  return policy.tasks[task]?.lanes ?? [];
}

// A lane's settings for a task; a stakes-forced lane with no row of its own borrows the
// first row that configures it (a Claude lane for a brief task gets the reason settings).
export function settingsFor(
  policy: RoutingPolicy,
  task: LaneTaskType,
  lane: ProviderId,
): LaneSettings | undefined {
  const own = policy.tasks[task]?.[lane] as LaneSettings | undefined;
  if (own !== undefined) return own;
  for (const t of LANE_TASK_TYPES) {
    const s = policy.tasks[t]?.[lane] as LaneSettings | undefined;
    if (s !== undefined) return s;
  }
  return undefined;
}

// Skill id → task type: SKILL.md frontmatter `task:` wins, then routing.yaml, then default.
export function taskForSkill(policy: RoutingPolicy, skillId: string, skillText = ""): LaneTaskType {
  const declared = /^\s+task:\s*"?([a-z]+)"?\s*$/m.exec(skillText.split(/\n---/)[0] ?? "")?.[1];
  if (declared !== undefined && (LANE_TASK_TYPES as readonly string[]).includes(declared)) {
    return declared as LaneTaskType;
  }
  return policy.skills[skillId] ?? policy.skills.default ?? "brief";
}

// Why a lane is switched off by policy, or null when it may be used. Checked before any probe,
// so an off lane never even looks for its key.
export function laneSwitchedOff(policy: RoutingPolicy, lane: ProviderId): string | null {
  if (lane === "anthropic-api" && !policy.caps["anthropic-api"].enabled) {
    return "switched off in routing.yaml (caps.anthropic-api.enabled: false) — no metered spend.";
  }
  return null;
}

export function isTaskType(value: string): value is LaneTaskType {
  return (LANE_TASK_TYPES as readonly string[]).includes(value);
}

// Front-door output → the stakes gates it names (from its `Domains:` line).
export function gatesIn(policy: RoutingPolicy, frontDoor: string | null): string[] {
  const domains = /^Domains:\s*(.*)$/m.exec(frontDoor ?? "")?.[1] ?? "";
  const named = domains.split("·").map((d) => d.trim());
  return policy.stakes.gates.filter((g) => named.includes(g));
}
