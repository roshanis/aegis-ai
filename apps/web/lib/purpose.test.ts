import { describe, expect, it } from "vitest";
import { asPurpose } from "./purpose";

describe("the intake sentence's purpose clause", () => {
  it("reads the requester's first sentence as a purpose", () => {
    expect(asPurpose("Summarizes provider letters for prior-auth nurses. Runs on Azure.")).toBe("summarize provider letters for prior-auth nurses");
    expect(asPurpose("Drafts appeal letters.")).toBe("draft appeal letters");
    expect(asPurpose("Classifies claims by urgency")).toBe("classify claims by urgency");
    expect(asPurpose("Matches members to programs")).toBe("match members to programs");
    expect(asPurpose("answer members' benefits questions")).toBe("answer members' benefits questions");
    expect(asPurpose("   ")).toBe("");
  });

  it("keeps it short", () => {
    const long = asPurpose(`Reads ${"very ".repeat(40)}long notes`);
    expect(long.length).toBeLessThanOrEqual(91);
    expect(long.endsWith("…")).toBe(true);
  });
});
