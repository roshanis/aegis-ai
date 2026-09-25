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

test("an AI system goes from intake through domain reviews, evidence and conditions to use", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Open a sandbox/ }).click();
  await expect(page).toHaveURL(/\/registry$/);
  await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();

  // Requester: one form, with live triage.
  await page.getByRole("link", { name: "+ Register AI" }).click();
  await page.getByLabel("What is it called?").fill("Benefits FAQ assistant");
  await answer(page, "Does it use protected health information?", false);
  await answer(page, "Will members see or interact with it?", true);
  await expect(page.locator(".tier-big")).toHaveText("Medium risk");
  await answer(page, "Could it influence care or coverage decisions?", false);
  await answer(page, "Does a person review every output before it takes effect?", true);
  await answer(page, "Is the model or service hosted by a vendor?", false);
  await answer(page, "Could it materially affect an individual?", false);
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page).toHaveURL(/\/registry\/[0-9a-f-]{36}$/);
  const asset = page.url();
  await expect(page.locator(".next-step")).toContainText("Add evidence for 3 controls");

  // Requester: evidence for the three gate controls.
  await page.goto(`${asset}?tab=controls`);
  for (const [id, title] of [["D-01", "Lineage document"], ["R-01", "Fairness test report"], ["T-01", "Architecture review minutes"]]) {
    const control = page.locator(`article#${id}`);
    await control.getByRole("button", { name: "+ Add evidence" }).click();
    await control.getByLabel("Title").fill(title!);
    await control.getByLabel("Link").fill(`https://docs.example.test/${id}`);
    await control.getByRole("button", { name: "Add evidence", exact: true }).click();
    await expect(control.getByText("Evidenced")).toBeVisible();
  }

  // Domain reviewers sign off their domains.
  for (const [reviewer, domains] of [
    ["Rowan Ellis", ["Data Governance", "Security", "Tech Architecture"]],
    ["Jordan Lee", ["Legal", "Responsible AI"]],
  ] as const) {
    await actAs(page, reviewer);
    await page.goto(asset);
    // The review drafter works in the background; the page refreshes itself until its drafts land.
    await expect(page.getByText("is drafting this review")).toHaveCount(0, { timeout: 20_000 });
    for (const domain of domains) {
      const review = page.locator("article").filter({ has: page.locator("strong", { hasText: new RegExp(`^${domain}$`) }) });
      await review.getByRole("button", { name: "Sign off" }).click();
      await review.getByRole("button", { name: "Confirm: sign off" }).click();
      await expect(review.getByText("Signed", { exact: true })).toBeVisible();
    }
  }

  // Approver: a conditional approval with a condition due before use.
  await actAs(page, "Avery Brooks");
  await page.goto(asset);
  await expect(page.getByText("All required reviews signed; ready for approval.").first()).toBeVisible();
  await page.getByRole("button", { name: "Approve with conditions" }).click();
  await page.getByLabel(/Why approve with conditions/).fill("Fine for members once the AI disclosure is live.");
  // The reviewers signed from the drafter's drafts, which proposed a condition for each monitor control.
  await expect(page.locator(".condition-row")).toHaveCount(3);
  await page.getByLabel("Condition 1", { exact: true }).fill("Show members an AI disclosure before the first answer");
  for (const n of [2, 3]) {
    await page.getByRole("group", { name: `When condition ${n} is due` }).getByRole("button", { name: "Ongoing" }).click();
  }
  await page.getByRole("button", { name: "Confirm: approve with conditions" }).click();
  await expect(page.locator(".banner")).toContainText("1 condition must be met before use");

  // Requester shows the condition is met; the approver accepts it.
  await actAs(page, "Riley Park");
  await page.goto(`${asset}?tab=conditions`);
  const condition = page.locator("article").filter({ hasText: "Show members an AI disclosure" });
  await condition.getByRole("button", { name: "+ Add evidence" }).click();
  await condition.getByRole("button", { name: "Written attestation" }).click();
  await condition.getByLabel("Title").fill("Disclosure live");
  await condition.getByLabel("What you attest to").fill("The disclosure banner shipped in release 4.2.");
  await condition.getByRole("button", { name: "Add evidence", exact: true }).click();
  await condition.getByRole("button", { name: "Submit for acceptance" }).click();
  await condition.getByRole("button", { name: "Confirm: submit for acceptance" }).click();
  await expect(condition.getByText("Evidence submitted")).toBeVisible();

  await actAs(page, "Avery Brooks");
  await page.goto(`${asset}?tab=conditions`);
  await condition.getByRole("button", { name: "Accept" }).click();
  await condition.getByRole("button", { name: "Confirm: accept" }).click();
  await expect(condition.getByText("Met", { exact: true })).toBeVisible();
  await expect(page.locator(".banner")).toContainText("Cleared for use.");

  // Admin puts it in use.
  await actAs(page, "Ada Morgan");
  await page.goto(asset);
  await page.getByRole("button", { name: "Put in use" }).click();
  await page.getByRole("button", { name: "Confirm: put in use" }).click();
  await expect(page.locator(".page-head .pill")).toHaveText("In use");

  // Auditor: who decided, why, under which policy; and nothing to click.
  await actAs(page, "Aubrey Kim");
  await page.goto(`${asset}?tab=history`);
  const decision = page.locator(".event[data-decision='true']").first();
  await expect(decision).toContainText("Avery Brooks approved it with conditions");
  await expect(decision).toContainText("Fine for members once the AI disclosure is live.");
  await expect(decision).toContainText("Policy healthcare-ai v1.2.0");
  await expect(page.locator(".event", { hasText: "Jordan Lee signed off Responsible AI" })).toBeVisible();
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
