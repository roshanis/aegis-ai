import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 2 through the real UI: the intake assistant suggests answers the
 * requester checks, the review drafter drafts each domain review, a
 * reviewer signs from a draft, and an admin controls the agents behind a
 * golden-set gate that a model change resets.
 */

async function actAs(page: Page, name: string) {
  await page.locator("summary[aria-label='Switch person']").click();
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await expect(page.locator("summary[aria-label='Switch person']")).toContainText(name);
}

const agentCard = (page: Page, title: string) => page.getByRole("region", { name: title });

test("agents draft and suggest, people decide, and an admin keeps them behind the golden-set gate", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Open a sandbox/ }).click();
  await expect(page).toHaveURL(/\/registry$/);

  // Requester: describe it, take the suggestions, answer what the assistant could not tell.
  await page.getByRole("link", { name: "+ Register AI" }).click();
  await page.getByLabel("What is it called?").fill("Marketing email drafter");
  await page
    .getByLabel("Describe it in a sentence or two")
    .fill("Generates first drafts of Medicare Advantage marketing emails. Compliance reviews every email before it is sent to members.");
  await page.getByRole("button", { name: "Suggest answers" }).click();
  const members = page.locator(".question").filter({ hasText: "Will members see or interact with it?" });
  await expect(members.getByText(/Suggested: Yes/)).toBeVisible();
  await expect(members.getByRole("button", { name: "Yes" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("2 left")).toBeVisible();
  for (const question of ["Does it use protected health information?", "Is the model or service hosted by a vendor?"]) {
    await page.getByRole("group", { name: question }).getByRole("button", { name: "No" }).click();
  }
  await expect(page.locator(".tier-big")).toHaveText("Medium risk");
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page).toHaveURL(/\/registry\/[0-9a-f-]{36}$/);
  const asset = page.url();

  // Reviewer: the drafter's draft is waiting; sign Security from it.
  await actAs(page, "Rowan Ellis");
  await page.goto(asset);
  await expect(page.getByText("is drafting this review")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator(".next-step")).toContainText("drafts ready");
  const security = page.locator("article").filter({ has: page.locator("strong", { hasText: /^Security$/ }) });
  await expect(security.getByText("AI draft")).toBeVisible();
  await expect(security.getByText("Draft ready to sign")).toBeVisible();
  await security.getByRole("button", { name: "Sign off" }).click();
  await expect(security.getByLabel(/starting from the draft/)).toHaveValue(/Security review of Marketing email drafter/);
  await security.getByRole("button", { name: "Confirm: sign off" }).click();
  await expect(security.getByText("Signed", { exact: true })).toBeVisible();

  await page.goto(`${asset}?tab=history`);
  await expect(page.locator(".event", { hasText: "Rowan Ellis signed off Security, keeping the drafter's memo" })).toBeVisible();
  await expect(page.locator(".event", { hasText: "Review drafter" }).filter({ hasText: "drafted the Security review" })).toContainText(
    "AI agent",
  );
  await expect(page.locator(".event", { hasText: "Riley Park submitted the intake, keeping 4 of 4 suggested answers" })).toBeVisible();

  // Reviewers see the agents but cannot switch them.
  await page.getByRole("link", { name: "Agents" }).click();
  await expect(agentCard(page, "Review drafter").getByText("On", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Turn (on|off)|Run .* golden set/ })).toHaveCount(0);

  // Admin: off and on again, and a fresh golden-set run.
  await actAs(page, "Ada Morgan");
  const drafter = agentCard(page, "Review drafter");
  await drafter.getByRole("button", { name: "Turn off the review drafter" }).click();
  await expect(drafter.getByText("Passed · off")).toBeVisible();
  await drafter.getByRole("button", { name: "Run the review drafter's golden set" }).click();
  await expect(drafter.getByText(/Passed its golden set: 100%/)).toBeVisible({ timeout: 20_000 });
  await expect(drafter.getByText("Run by Ada Morgan · just now")).toBeVisible();
  await drafter.getByRole("button", { name: "Turn on the review drafter" }).click();
  await expect(drafter.getByText("On", { exact: true })).toBeVisible();

  // A different model resets the gate; the one that passed counts again when it comes back.
  await page.getByRole("button", { name: "Change model" }).click();
  await page.getByRole("group", { name: "Provider" }).getByRole("button", { name: "OpenAI" }).click();
  await page.getByRole("textbox", { name: "Model" }).fill("gpt-5-mini");
  await page.getByLabel("API key").fill("sk-test-not-a-real-key-1234");
  await page.getByRole("button", { name: "Save model" }).click();
  await expect(page.getByRole("heading", { name: "OpenAI · gpt-5-mini" })).toBeVisible();
  await expect(page.getByText("key ending 1234", { exact: false })).toBeVisible();
  for (const title of ["Intake assistant", "Review drafter"]) {
    await expect(agentCard(page, title).getByText("It has not passed its golden set on this model.")).toBeVisible();
  }
  await page.getByRole("button", { name: "Change model" }).click();
  await page.getByRole("group", { name: "Provider" }).getByRole("button", { name: "Scripted demo" }).click();
  await page.getByRole("button", { name: "Save model" }).click();
  await expect(page.getByRole("heading", { name: "Scripted demo model" })).toBeVisible();
  await expect(agentCard(page, "Intake assistant").getByText("Passed · off")).toBeVisible();

  // With the intake assistant off, the form is the plain form.
  await actAs(page, "Riley Park");
  await page.getByRole("link", { name: "Register AI", exact: true }).click();
  await expect(page.getByLabel("What is it called?")).toBeVisible();
  await expect(page.getByLabel("Describe it in a sentence or two")).toHaveCount(0);
});
