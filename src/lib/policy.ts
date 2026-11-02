export type MilestoneId = "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7" | "M8";

export type Capability =
  | "ollama-local"
  | "github"
  | "skills"
  | "rooms"
  | "multi-provider"
  | "evals"
  | "litellm"
  | "mcp"
  | "documents"
  | "memory";

const CAPABILITY_AT: Record<Capability, MilestoneId> = {
  "ollama-local": "M1",
  github: "M1",
  skills: "M2",
  rooms: "M2",
  "multi-provider": "M3",
  evals: "M4",
  litellm: "M5",
  mcp: "M6",
  documents: "M7",
  memory: "M8",
};

const MILESTONE_ORDER: readonly MilestoneId[] = ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8"];

let activeMilestone: MilestoneId = "M8";

export function setActiveMilestone(next: MilestoneId): void {
  activeMilestone = next;
}

export function getActiveMilestone(): MilestoneId {
  return activeMilestone;
}

function milestoneIndex(id: MilestoneId): number {
  return MILESTONE_ORDER.indexOf(id);
}

export class CapabilityOutOfScopeError extends Error {
  constructor(capability: Capability, neededAt: MilestoneId, active: MilestoneId) {
    super(
      `Capability '${capability}' is scheduled for milestone ${neededAt}, ` +
        `but the active milestone is ${active}. This call is rejected by the milestone scope policy.`,
    );
    this.name = "CapabilityOutOfScopeError";
  }
}

export function isCapabilityAllowed(capability: Capability): boolean {
  const neededAt = CAPABILITY_AT[capability];
  return milestoneIndex(neededAt) <= milestoneIndex(activeMilestone);
}

export function assertCapability(capability: Capability): void {
  if (!isCapabilityAllowed(capability)) {
    throw new CapabilityOutOfScopeError(capability, CAPABILITY_AT[capability], activeMilestone);
  }
}

export function listAllowedCapabilities(): Capability[] {
  return (Object.keys(CAPABILITY_AT) as Capability[]).filter(isCapabilityAllowed);
}
