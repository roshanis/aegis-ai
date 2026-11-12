import type { ContentPack } from "./types";

/**
 * Member communications for Medicare Advantage and Part D plans. A starter
 * rubric drawn from the communications and marketing rules in 42 CFR 422
 * and 423 Subpart V and CMS' Medicare Communications and Marketing
 * Guidelines. Rules with a text check run in code; the rest need a person.
 * A demonstration, not legal coverage: a plan's compliance team must review
 * and adapt it before relying on it.
 */
export const cmsMemberCommunicationsPack: ContentPack = {
  kind: "content",
  id: "cms-member-communications",
  version: "1.0.0",
  title: "Medicare member communications",
  summary:
    "Checks Medicare Advantage and Part D member and marketing materials for required statements and prohibited claims before they go out.",
  frameworkRefs: [
    "42 CFR 422 Subpart V (MA communications and marketing)",
    "42 CFR 423 Subpart V (Part D communications and marketing)",
    "CMS Medicare Communications and Marketing Guidelines",
  ],
  markets: ["MA", "PDP"],
  rubric: {
    failOn: ["critical", "major"],
    criteria: [
      {
        id: "M1",
        title: "No claim of Medicare endorsement",
        severity: "critical",
        description: "Does not say or imply that Medicare, CMS, Social Security or the federal government endorses, recommends or sponsors the plan.",
        recommendation: "Remove the endorsement claim. A plan may say it has a contract with Medicare, nothing more.",
        check: {
          forbids: [
            "\\b(endorsed|recommended|sponsored|backed|approved)\\s+by\\s+(medicare|cms|the centers for medicare[^.\\n]*|social security|the (federal )?government)\\b",
            "\\b(medicare|cms|the (federal )?government)\\s+(endorses|recommends|sponsors)\\b",
          ],
        },
      },
      {
        id: "M2",
        title: "Federal contracting statement",
        severity: "major",
        description: "Says the plan has a contract with Medicare and that enrollment depends on contract renewal.",
        recommendation: "Add: “[Plan] is a [plan type] plan with a Medicare contract. Enrollment in [Plan] depends on contract renewal.”",
        check: { requires: ["\\b(contract with medicare|medicare contract)\\b", "\\bdepends on contract renewal\\b"] },
      },
      {
        id: "M3",
        title: "Material ID",
        severity: "major",
        description: "Carries a material ID: the contract number, an underscore, and the plan's own identifier.",
        recommendation: "Add the material ID, for example H1234_FLYER26_C.",
        check: { requires: ["\\b[HRSEY]\\d{4}_[A-Z0-9]+(_[A-Z0-9]+)*\\b"] },
      },
      {
        id: "M4",
        title: "Customer service and TTY",
        severity: "major",
        description: "Gives a customer service phone number with a TTY number (or 711).",
        recommendation: "Add the customer service number, the TTY number and the hours it is answered.",
        check: { requires: ["\\b(TTY|TDD|711)\\b", "\\(?\\b\\d{3}\\)?[-. ]?\\d{3}[-. ]\\d{4}\\b"] },
      },
      {
        id: "M5",
        title: "Language assistance",
        severity: "major",
        description: "Tells members that free interpreter and language assistance services are available.",
        recommendation: "Add the notice that free language assistance and interpreter services are available, with how to ask for them.",
        check: { requires: ["\\b(interpreters?|language assistance|language services)\\b"] },
      },
      {
        id: "M6",
        title: "Star Ratings disclaimer",
        severity: "major",
        description: "When Star Ratings are mentioned, says Medicare evaluates plans every year on a 5-star rating system.",
        recommendation: "Add: “Every year, Medicare evaluates plans based on a 5-star rating system.”",
        check: {
          when: "\\b(star ratings?|[1-5](\\.\\d)?[- ]stars?)\\b",
          requires: ["\\b(every|each) year\\b[^.\\n]*\\b(5|five)[- ]star rating system\\b"],
        },
      },
      {
        id: "M7",
        title: "No unsupported superlatives",
        severity: "critical",
        description: "Uses words like “best”, “#1” or “highest rated” only with a cited, current source.",
        recommendation: "Remove the superlative, or cite the source and year that supports it.",
        check: {
          forbids: ["\\b(the best|best plan|#1|number one|no\\.\\s?1|highest[- ]rated|top[- ]rated|lowest[- ]cost)\\b"],
          confidence: "low",
        },
      },
      {
        id: "M8",
        title: "No cash or high-value gifts",
        severity: "critical",
        description: "Offers no cash, gift cards or other cash equivalents, and no gift worth more than nominal value, to get people to enroll.",
        recommendation: "Remove the offer, or limit it to a nominal-value promotional item open to everyone regardless of enrollment.",
        check: { forbids: ["\\b(cash( back)?|gift cards?|prepaid cards?|visa cards?|rebates?)\\b"], confidence: "low" },
      },
      {
        id: "M9",
        title: "No requests for identifiers",
        severity: "critical",
        description: "Does not ask people to send a Medicare number, Social Security number or bank details by reply, email or text.",
        recommendation: "Remove the request. Collect identifiers only through the plan's secure enrollment channels.",
        check: {
          forbids: [
            "\\b(reply|respond|email|e-mail|text|send|write back)\\b[^.\\n]{0,80}\\b(social security|ssn|medicare (number|card|id)|mbi|bank account)\\b",
          ],
        },
      },
      {
        id: "M10",
        title: "No pressure or scare tactics",
        severity: "critical",
        description: "Does not pressure people with false urgency or threats of losing their benefits.",
        recommendation: "Remove the urgency or threat; state enrollment periods plainly.",
        check: {
          forbids: [
            "\\b(act now|last chance|before it'?s too late|only \\d+ (spots|days) left|you will lose your (medicare|benefits|coverage))\\b",
          ],
          confidence: "low",
        },
      },
      {
        id: "M11",
        title: "Benefits match the Evidence of Coverage",
        severity: "major",
        description: "Benefits, premiums and cost sharing are stated accurately and match the plan's Evidence of Coverage for the plan year.",
        recommendation: "Check every benefit and cost against the Evidence of Coverage and correct what differs.",
      },
      {
        id: "M12",
        title: "Plain language",
        severity: "minor",
        description: "A member can understand it and knows what to do next.",
        recommendation: "Shorten sentences, define terms, and end with one clear next step.",
      },
      {
        id: "M13",
        title: "Plan type named",
        severity: "major",
        description: "Medicare Advantage materials name the plan type (HMO, PPO, PFFS, SNP or MSA).",
        recommendation: "Name the plan type wherever the plan is introduced.",
        jurisdictions: ["MA"],
        check: { requires: ["\\b(HMO|PPO|PFFS|SNP|MSA)\\b"] },
      },
      {
        id: "M14",
        title: "Extra Help",
        severity: "minor",
        description: "Part D materials that discuss costs mention Extra Help for people with limited income.",
        recommendation: "Add a line about Extra Help and how to apply.",
        jurisdictions: ["PDP"],
        check: { when: "\\b(premiums?|copays?|copayments?|deductibles?|costs?)\\b", requires: ["\\bextra help\\b"] },
      },
    ],
  },
};
