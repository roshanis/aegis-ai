import { describe, expect, it } from "vitest";
import { decideVerdict, sliceRubric, verdictsByJurisdiction, worstVerdict, type Finding, type Rubric } from "./verdict";

const rubric: Rubric = {
  failOn: ["critical", "major"],
  criteria: [
    { id: "C1", severity: "major", description: "risk disclaimer" },
    { id: "C6", severity: "major", description: "capital at risk", jurisdictions: ["UK"] },
    { id: "C5", severity: "minor", description: "fee schedule" },
  ],
};

const finding = (criterionId: string, severity: Finding["severity"], confidence?: "high" | "low"): Finding => ({
  criterionId,
  severity,
  quote: "",
  explanation: "",
  recommendation: "",
  ...(confidence ? { confidence } : {}),
});

describe("content verdicts", () => {
  it("fails on a confident fail-level finding", () => {
    expect(decideVerdict([finding("C1", "major")], rubric)).toBe("fail");
  });

  it("routes low-confidence or minor findings to a person", () => {
    expect(decideVerdict([finding("C1", "major", "low")], rubric)).toBe("needs_human_review");
    expect(decideVerdict([finding("C5", "minor")], rubric)).toBe("needs_human_review");
  });

  it("does not pass a document whose coverage is incomplete", () => {
    expect(decideVerdict([], rubric, [{ criterionId: "C1", status: "checked" }])).toBe("pass");
    expect(decideVerdict([], rubric, [{ criterionId: "C1", status: "omitted" }])).toBe("needs_human_review");
  });

  it("applies market-specific criteria only in their markets", () => {
    expect(sliceRubric(rubric, ["US"]).criteria.map((c) => c.id)).toEqual(["C1", "C5"]);
    expect(verdictsByJurisdiction([finding("C6", "major")], rubric, ["US", "UK"])).toEqual([
      { jurisdiction: "US", verdict: "pass" },
      { jurisdiction: "UK", verdict: "fail" },
    ]);
  });

  it("takes the worst verdict", () => {
    expect(worstVerdict(["pass", "needs_human_review"])).toBe("needs_human_review");
    expect(worstVerdict([])).toBe("pass");
  });
});
