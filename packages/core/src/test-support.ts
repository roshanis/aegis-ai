import type { HumanPrincipal } from "@aegis/domain";
import { healthcareAiPack } from "@aegis/frameworks";
import type { Governance } from "./governance";

/** Every review domain in the healthcare pack, for a reviewer who can sign them all. */
export const ALL_DOMAINS = Object.keys(healthcareAiPack.domains);

/** Evidence every uncovered gate control as the owner, then sign every open domain review. */
export async function readyForDecision(
  gov: Governance,
  owner: HumanPrincipal,
  reviewer: HumanPrincipal,
  assetId: string,
): Promise<void> {
  const view = await gov.getAsset(owner, assetId);
  for (const control of view.assurance.controls.filter((c) => c.enforcement === "gate" && !c.covered)) {
    await gov.addEvidence(owner, {
      assetId,
      controlId: control.id,
      kind: "link",
      title: control.requiredEvidence,
      url: `https://docs.example.test/${control.id}`,
    });
  }
  const reviewing = await gov.getAsset(reviewer, assetId);
  for (const review of reviewing.assurance.reviews.filter((r) => r.actions.includes("sign"))) {
    await gov.reviewDomain(reviewer, review.caseId, review.domain, "sign", { expectedRevision: review.revision });
  }
}
