import { describe, expect, it } from "vitest";
import { can, canSignDomain, roleConflicts } from "./roles";
import { agent, human, system } from "./test-principals";

describe("roles", () => {
  it("grants permissions by role", () => {
    expect(can(human(["approver"]), "case.decide")).toBe(true);
    expect(can(human(["requester"]), "case.decide")).toBe(false);
    expect(can(human(["admin"]), "case.decide")).toBe(false);
  });

  it("gives agents and system jobs no human permissions", () => {
    expect(can(agent, "review.sign")).toBe(false);
    expect(can(system, "case.decide")).toBe(false);
  });

  it("refuses every permission to a person holding incompatible roles", () => {
    const both = human(["admin", "approver"]);
    expect(roleConflicts(both.roles)).toHaveLength(1);
    expect(can(both, "case.decide")).toBe(false);
    expect(can(both, "tenant.manage")).toBe(false);
  });

  it("scopes signing to the reviewer's domains", () => {
    const privacy = human(["reviewer"], ["privacy"]);
    expect(canSignDomain(privacy, "privacy")).toBe(true);
    expect(canSignDomain(privacy, "security")).toBe(false);
  });
});
