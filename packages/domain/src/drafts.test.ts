import { describe, expect, it } from "vitest";
import { checkDraft, decisionLanguage, draftMemo, draftUse, type ReviewDraft } from "./drafts";

const draft = (over: Partial<ReviewDraft> = {}): ReviewDraft => ({
  summary: "Legal review of the meeting summarizer. The vendor addendum is not on file yet.",
  findings: [{ controlId: "L-01", concern: "missing_evidence", text: "No signed AI addendum on file." }],
  questionsForOwner: ["Can you attach the signed addendum?"],
  proposedConditions: [],
  ...over,
});

describe("decision language", () => {
  it.each([
    "This system is approved for production.",
    "The tool has been cleared for use.",
    "Cleared for use once the BAA is signed.",
    "I approve this review.",
    "We hereby certify the model.",
    "No further review is needed.",
    "The assistant is fully HIPAA compliant.",
    "The review has been signed off.",
  ])("catches %s", (text) => {
    expect(decisionLanguage(text)).not.toBeNull();
  });

  it.each([
    "The vendor contract was approved by Legal in 2024.",
    "Recommend signing once L-01 is on file.",
    "The approver may want a quarterly bias check as a condition.",
    "Evidence shows the DPIA covers HIPAA requirements.",
    "Compliance reviews every email before it is sent.",
  ])("lets %s through", (text) => {
    expect(decisionLanguage(text)).toBeNull();
  });
});

describe("checking a draft", () => {
  it("tidies text and keeps a clean draft", () => {
    const result = checkDraft(
      draft({ findings: [{ controlId: " l-01 ", concern: "missing_evidence", text: "  No   addendum. " }], questionsForOwner: ["a", "a", ""] }),
      ["L-01", "L-02"],
    );
    expect(result).toEqual({
      ok: true,
      draft: draft({ findings: [{ controlId: "L-01", concern: "missing_evidence", text: "No addendum." }], questionsForOwner: ["a"] }),
    });
  });

  it("rejects a control the case does not have", () => {
    expect(checkDraft(draft({ findings: [{ controlId: "X-99", concern: "risk", text: "made up" }] }), ["L-01"])).toMatchObject({
      ok: false,
      code: "unknown_control",
      detail: "X-99",
    });
  });

  it("rejects decision language anywhere, including proposed conditions", () => {
    expect(checkDraft(draft({ proposedConditions: ["None; no further review is required."] }), ["L-01"])).toMatchObject({
      ok: false,
      code: "decision_language",
    });
  });

  it("rejects a draft with nothing to read", () => {
    expect(checkDraft(draft({ summary: "   " }), ["L-01"])).toMatchObject({ ok: false, code: "invalid_output" });
  });
});

describe("signing from a draft", () => {
  it("records whether the reviewer kept the memo as drafted", () => {
    const d = draft();
    expect(draftMemo(d)).toBe(`${d.summary}\n\n- L-01: No signed AI addendum on file.`);
    expect(draftUse(d, draftMemo(d).replace("\n\n", "\n"))).toBe("as_drafted");
    expect(draftUse(d, `${draftMemo(d)} Also checked the DPA.`)).toBe("edited");
    expect(draftUse(d, "  ")).toBe("not_used");
    expect(draftUse(null, "anything")).toBe("none");
  });
});
