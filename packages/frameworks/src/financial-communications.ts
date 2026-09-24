import type { ContentPack } from "./types";

/**
 * Pre-publication review for investment marketing. Starter rubric ported
 * from Cleared (src/prompts/rubric.md). A demonstration, not legal
 * coverage: tenants must replace it with their own reviewed policy.
 */
export const financialCommunicationsPack: ContentPack = {
  kind: "content",
  id: "financial-communications",
  version: "1.0.0",
  title: "Investment communications",
  summary: "Checks customer-facing investment copy for guarantees, missing risk language and unsafe data requests.",
  frameworkRefs: ["FINRA Rule 2210", "SEC Marketing Rule 206(4)-1", "FCA COBS 4", "EU Green Claims"],
  markets: ["US", "UK", "EU"],
  rubric: {
    failOn: ["critical", "major"],
    criteria: [
      {
        id: "C1",
        severity: "major",
        description:
          "Contains a risk disclaimer equivalent to 'past performance is not indicative of future results' and states that investments may lose value.",
      },
      {
        id: "C2",
        severity: "critical",
        description: "Makes no guarantee of performance or returns ('guaranteed', 'risk-free', 'can't lose', promised rates).",
      },
      {
        id: "C3",
        severity: "major",
        description: "Names a competitor in a comparative claim only with cited substantiation (dated study or published benchmark).",
      },
      {
        id: "C4",
        severity: "critical",
        description: "Does not request or expose sensitive personal data (SSN, full account numbers, passwords) over an unsecured channel.",
      },
      {
        id: "C5",
        severity: "minor",
        description: "Any mention of fees refers the reader to the full fee schedule or Form ADV.",
      },
      {
        id: "C6",
        severity: "major",
        description: "Investment promotions carry a capital-at-risk warning.",
        jurisdictions: ["UK"],
      },
      {
        id: "C7",
        severity: "minor",
        description: "Sustainability or 'green' claims are substantiated (certified, accredited or referenced).",
        jurisdictions: ["EU"],
      },
    ],
  },
};
