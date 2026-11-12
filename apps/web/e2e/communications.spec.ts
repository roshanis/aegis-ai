import { expect, test, type Page } from "@playwright/test";

/**
 * Member communications review through the real UI: a writer pastes a flyer
 * and sees the pack's rules run as they type, the compliance officer sees
 * the broken rule marked in the text and asks for changes, the writer sends
 * a fixed version, and the officer approves it with a reason.
 */

const person = (page: Page) => page.locator("details.menu > summary");

async function actAs(page: Page, name: string) {
  await person(page).click();
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await expect(person(page)).toHaveAttribute("aria-label", new RegExp(`^${name},`));
}

const FLYER = `Lakeview Health Advantage (HMO)

Your 2027 benefits at a glance: $0 premium, $5 primary care copays, and dental coverage.
Call Member Services at 1-800-555-0199 (TTY 711), 8 a.m. to 8 p.m., seven days a week.
Free language assistance and interpreter services are available. Call the number above.
Lakeview Health is an HMO plan with a Medicare contract. Enrollment in Lakeview Health depends on contract renewal.
H4321_FLYER27_C`;

const ENDORSED = "Lakeview Health Advantage is endorsed by Medicare.";

test("a member communication is checked as it is written, sent back, fixed, and approved", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open a sandbox" }).click();
  await expect(page).toHaveURL(/\/today$/, { timeout: 30_000 });
  await actAs(page, "Riley Park");

  // Writer: from the intake, a member communication goes to its own form.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Intake" }).click();
  await page.getByRole("button", { name: "Member communication" }).click();
  await expect(page).toHaveURL(/\/registry\/new\/communication$/);
  await page.getByLabel("What is it called?").fill("Lakeview 2027 flyer");
  await page.getByLabel("The text, as members will read it").fill(`${FLYER}\n${ENDORSED}`);
  const check = page.getByRole("region", { name: "Rule check" });
  await expect(check.getByText("Breaks a rule", { exact: true })).toBeVisible();
  await expect(check.getByText("M1 No claim of Medicare endorsement")).toBeVisible();
  await page.getByRole("button", { name: "Send to the officer" }).click();
  await expect(page).toHaveURL(/\/registry\/[0-9a-f-]{36}$/);
  const asset = page.url();
  await expect(page.locator(".communication-body mark").first()).toContainText(ENDORSED);
  await expect(page.getByText("Waiting on the compliance officer.")).toBeVisible();

  // Officer: the broken rule is marked; ask for changes, with a reason.
  await actAs(page, "Avery Brooks");
  await page.goto(asset);
  await page.getByLabel(/^Reason/).fill("Remove the endorsement line before this goes out.");
  await page.getByRole("button", { name: "Request changes" }).click();
  await expect(page.getByText(/Waiting on Riley Park to send a new version/)).toBeVisible();

  // Writer: the last version is filled in; take the line out and send it again.
  await actAs(page, "Riley Park");
  await page.goto(asset);
  const text = page.getByLabel("The text, as members will read it");
  await expect(text).toHaveValue(`${FLYER}\n${ENDORSED}`);
  await text.fill(FLYER);
  await expect(page.getByRole("region", { name: "Rule check" }).getByText("Breaks a rule", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Send the new version" }).click();
  await expect(page.getByText("Waiting on the compliance officer.")).toBeVisible();
  await expect(page.locator(".communication-body mark")).toHaveCount(0);

  // Officer: approve version 2, with a reason; version 1 stays as it was.
  await actAs(page, "Avery Brooks");
  await page.goto(asset);
  await page.getByLabel(/^Reason/).fill("Endorsement line removed; the rest reads as filed.");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved").first()).toBeVisible();
  await page.goto(`${asset}?v=1`);
  await expect(page.locator(".communication-body mark").first()).toContainText(ENDORSED);
});
