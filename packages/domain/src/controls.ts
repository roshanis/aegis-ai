import { TIERS, evaluate, type Answers, type Condition, type Tier } from "./triage";

/**
 * Controls: what must be in place, with evidence, for a system under a
 * review domain. A policy pack carries its control catalog as data;
 * applicability uses the same condition language as triage, plus an
 * optional minimum tier.
 */
export interface ControlDefinition {
  /** Stable id within the pack, e.g. "H-01". */
  readonly id: string;
  /** The review domain that owns this control. */
  readonly domain: string;
  readonly name: string;
  /** What a reviewer expects to see, e.g. "DPIA + BAA". */
  readonly requiredEvidence: string;
  /**
   * gate: evidence or an approved exception is required before the domain
   * can be signed and before the system is put in use.
   * monitor: tracked on a cadence, never blocking.
   */
  readonly enforcement: "gate" | "monitor";
  readonly cadence: string;
  readonly when: Condition;
  readonly minTier?: Tier;
  /** External frameworks this control helps evidence. Never "certifies". */
  readonly frameworkRefs: readonly string[];
}

export function controlApplies(control: ControlDefinition, tier: Tier, answers: Answers): boolean {
  if (control.minTier && TIERS.indexOf(tier) < TIERS.indexOf(control.minTier)) return false;
  return evaluate(control.when, answers);
}

/** The controls a case must address: those in its required review domains that apply to its tier and answers. */
export function requiredControls(
  catalog: readonly ControlDefinition[],
  triaged: { readonly tier: Tier; readonly domains: readonly string[] },
  answers: Answers,
): ControlDefinition[] {
  return catalog
    .filter((c) => triaged.domains.includes(c.domain) && controlApplies(c, triaged.tier, answers))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface ControlCoverage {
  readonly evidence: number;
  readonly activeException: boolean;
}

/** A control is covered when it has evidence or an active, approved exception. */
export const isCovered = (coverage: ControlCoverage | undefined): boolean =>
  Boolean(coverage && (coverage.evidence > 0 || coverage.activeException));

/** Gate controls that are neither evidenced nor excepted. */
export function uncoveredGates(
  controls: readonly ControlDefinition[],
  coverage: (controlId: string) => ControlCoverage | undefined,
): ControlDefinition[] {
  return controls.filter((c) => c.enforcement === "gate" && !isCovered(coverage(c.id)));
}
