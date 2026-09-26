import type { ControlDefinition, FastLanePolicy, Rubric, TriagePolicy } from "@aegis/domain";

/**
 * A policy pack is versioned data a tenant enables. Packs never contain
 * code, so compliance leads can review, fork and diff them like documents.
 */
interface PackBase {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly summary: string;
  /** External frameworks this pack helps evidence, e.g. "NIST AI RMF: MAP 1.1". */
  readonly frameworkRefs: readonly string[];
}

export interface IntakeQuestion {
  readonly field: string;
  readonly label: string;
  readonly help: string;
}

/**
 * Golden sets: worked examples that define what "good" means for an agent
 * under this pack. An agent may be turned on for a tenant only after it
 * passes the pack's golden set on that tenant's model. They ship with the
 * pack so the people who own the rules also own the test.
 */
export interface GoldenSet<Case> {
  readonly id: string;
  readonly version: string;
  /** Minimum mean score, 0 to 1. Any critical failure fails the set regardless of score. */
  readonly threshold: number;
  readonly cases: readonly Case[];
}

/** A description a requester might type, and the intake answers a careful reviewer would give. */
export interface IntakeGoldenCase {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Fields left out could fairly go either way and are not scored. */
  readonly expected: Readonly<Record<string, boolean>>;
}

/** One domain review on a realistic case, with the evidence on file. */
export interface DraftGoldenCase {
  readonly id: string;
  readonly title: string;
  readonly asset: { readonly kind: string; readonly name: string };
  /** Every intake question answered, so triage and control applicability are exact. */
  readonly answers: Readonly<Record<string, boolean>>;
  readonly domain: string;
  /** Evidence on file by control id; controls left out have none. */
  readonly evidence: Readonly<Record<string, readonly { readonly title: string; readonly detail?: string }[]>>;
  /** Controls covered by an approved exception instead of evidence. */
  readonly exceptions?: readonly string[];
  /** The latest exchange on the review, when the owner has answered a question. */
  readonly thread?: string;
  /** Beyond the checks every draft gets: the draft should ask the owner something. */
  readonly asksOwner?: boolean;
}

export interface InitiativeGoldenSets {
  readonly intake: GoldenSet<IntakeGoldenCase>;
  readonly reviewDrafter: GoldenSet<DraftGoldenCase>;
}

/**
 * The intake as one sentence. Each question becomes a phrase the requester
 * can flip between its yes and no wording, and the requester's own words go
 * where {purpose} is. Screens render it; triage still reads only the
 * yes-or-no answers, so the sentence can never change a tier.
 */
export interface IntakeSentence {
  /** Plain text with {field} for each question's phrase and {purpose} for the requester's words. */
  readonly template: string;
  readonly phrases: Readonly<Record<string, { readonly yes: string; readonly no: string }>>;
  /** Finishes "… risk, because it" for each tier rule, and under "default" for when no rule matches. */
  readonly because: Readonly<Record<string, string>>;
}

export interface InitiativePack extends PackBase {
  readonly kind: "initiative";
  readonly questions: readonly IntakeQuestion[];
  /** The same questions as one sentence, for intake screens that offer it. */
  readonly sentence?: IntakeSentence;
  readonly domains: Readonly<Record<string, string>>;
  readonly triage: TriagePolicy;
  readonly fastLane: FastLanePolicy;
  /** The control catalog; a case must address those in its review domains that apply. */
  readonly controls: readonly ControlDefinition[];
  /** How agents are tested before a tenant may turn them on. */
  readonly goldenSets?: InitiativeGoldenSets;
}

export interface ContentPack extends PackBase {
  readonly kind: "content";
  readonly markets: readonly string[];
  readonly rubric: Rubric;
}

export type PolicyPack = InitiativePack | ContentPack;
