import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 0's walking skeleton, through the real UI: a visitor opens a
 * sandbox, a requester registers an AI system, an approver decides, an
 * admin puts it in use, and an auditor finds who approved it, why, and
 * under which policy version.
 */

async function actAs(page: Page, name: string) {
  await page.locator("summary[aria-label='Switch person']").click();
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await expect(page.locator("summary[aria-label='Switch person']")).toContainText(name);
}

async function answer(page: Page, question: string, yes: boolean) {
  await page
    .getByRole("group", { name: question })
    .getByRole("button", { name: yes ? "Yes" : "No" })
    .click();
}

test("an AI system goes from intake to use, and the auditor can prove the decision", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Open a sandbox/ }).click();
  await expect(page).toHaveURL(/\/registry$/);
  await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();

  // Requester: one form, with live triage.
  await page.getByRole("link", { name: "+ Register AI" }).click();
  await page.getByLabel("What is it called?").fill("Appeals letter drafter");
  await answer(page, "Does it use protected health information?", true);
  await expect(page.locator(".tier-big")).toHaveText("High risk");
  await answer(page, "Will members see or interact with it?", true);
  await answer(page, "Could it influence care or coverage decisions?", false);
  await answer(page, "Does a person review every output before it takes effect?", true);
  await answer(page, "Is the model or service hosted by a vendor?", true);
  await answer(page, "Could it materially affect an individual?", true);
  await expect(page.getByText("adds Privacy / HIPAA: uses PHI")).toBeVisible();
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page).toHaveURL(/\/registry\/[0-9a-f-]{36}$/);
  const asset = page.url();
  await expect(page.getByText("Waiting on an approver's decision.")).toBeVisible();

  // Approver: decides from one screen, with a reason.
  await actAs(page, "Avery Brooks");
  await page.goto(asset);
  await page.getByRole("button", { name: "Approve with conditions" }).click();
  await page.getByLabel(/Why\?/).fill("Letters pass clinical review before mailing.");
  await page.getByRole("button", { name: "Confirm: approve with conditions" }).click();
  await expect(page.getByText("Cleared for use.")).toBeVisible();

  // Admin: puts it in use.
  await actAs(page, "Ada Morgan");
  await page.getByRole("button", { name: "Put in use" }).click();
  await page.getByRole("button", { name: "Confirm: put in use" }).click();
  await expect(page.locator(".page-head .pill")).toHaveText("In use");

  // Auditor: the decision, who made it, why, under which policy, and nothing to click.
  await actAs(page, "Aubrey Kim");
  const decision = page.locator(".event[data-decision='true']").first();
  await expect(decision).toContainText("Avery Brooks approved it with conditions");
  await expect(decision).toContainText("Letters pass clinical review before mailing.");
  await expect(decision).toContainText("Policy healthcare-ai v1.0.0");
  await expect(page.locator("main button")).toHaveCount(0);
});

test("a session cookie edited to become the admin gets no one in", async ({ page, context }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Open a sandbox/ }).click();
  await expect(page).toHaveURL(/\/registry$/);
  // A real person in the same tenant, so only the signature stands in the way.
  const admin = await page.locator("input[name='userId']").first().inputValue();
  const [session] = await context.cookies();
  const [body, signature] = session!.value.split(".");
  const payload = JSON.parse(Buffer.from(body!, "base64url").toString());
  expect(payload.u).not.toBe(admin);
  const forged = Buffer.from(JSON.stringify({ ...payload, u: admin })).toString("base64url");
  await context.addCookies([{ ...session!, value: `${forged}.${signature}` }]);
  await page.goto("/registry");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: /Open a sandbox/ })).toBeVisible();
});
