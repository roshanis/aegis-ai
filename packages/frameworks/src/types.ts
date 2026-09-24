import type { FastLanePolicy, Rubric, TriagePolicy } from "@aegis/domain";

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

export interface InitiativePack extends PackBase {
  readonly kind: "initiative";
  readonly questions: readonly IntakeQuestion[];
  readonly domains: Readonly<Record<string, string>>;
  readonly triage: TriagePolicy;
  readonly fastLane: FastLanePolicy;
}

export interface ContentPack extends PackBase {
  readonly kind: "content";
  readonly markets: readonly string[];
  readonly rubric: Rubric;
}

export type PolicyPack = InitiativePack | ContentPack;
