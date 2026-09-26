/**
 * The agents Aegis ships. Each one drafts or suggests; none holds any
 * permission. `version` changes whenever instructions or output shape
 * change, and a tenant's passing evaluation counts only for the version
 * it tested.
 */
export const AGENT_IDS = ["intake", "review-drafter"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export interface AgentInfo {
  readonly id: AgentId;
  readonly version: string;
  readonly title: string;
  /** What it does, in one sentence a requester or reviewer would understand. */
  readonly purpose: string;
  /** What leaves Aegis for the tenant's model when it runs. */
  readonly sends: string;
}

export const AGENTS: Readonly<Record<AgentId, AgentInfo>> = {
  intake: {
    id: "intake",
    version: "1.0.0",
    title: "Intake assistant",
    purpose: "Suggests answers to the intake questions from a short description. The requester checks and submits every answer.",
    sends: "The description the requester typed and the intake questions.",
  },
  "review-drafter": {
    id: "review-drafter",
    version: "1.0.0",
    title: "Review drafter",
    purpose:
      "Drafts each domain review from the intake, the controls and the evidence on file. A reviewer signs, edits or ignores the draft.",
    sends: "For one domain review: the system's name and intake answers, that domain's controls, the evidence titles and attestation text on file, and the latest question and answer on the review.",
  },
};

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}
