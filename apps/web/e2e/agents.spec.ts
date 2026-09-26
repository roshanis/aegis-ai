import { expect, test, type Page } from "@playwright/test";

/**
 * Agents through the real UI: the intake assistant suggests phrases the
 * requester checks, the review drafter drafts each seat's review in a
 * dashed frame, a reviewer signs from a draft, and an admin controls the
 * agents behind a golden-set gate that a model change resets.
 */

const person = (page: Page) => page.locator("details.menu > summary");

async function actAs(page: Page, name: string) {
  await person(page).click();
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await expect(person(page)).toHaveAttribute("aria-label", new RegExp(`^${name},`));
}

const rail = (page: Page, name: string) => page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name, exact: true });
const agentCard = (page: Page, title: string) => page.getByRole("region", { name: title });

test("agents draft and suggest, people decide, and an admin keeps them behind the golden-set gate", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open a sandbox" }).click();
  // Seeding runs the agents' golden sets and drafts, which takes a few seconds.
  await expect(page).toHaveURL(/\/today$/, { timeout: 30_000 });

  // Requester: say what it does, take the suggested phrases, settle what the assistant could not tell.
  await rail(page, "Intake").click();
  await page.getByLabel("What is it called?").fill("Marketing email drafter");
  await page
    .getByLabel("What does it do? In your words")
    .fill("Generates first drafts of Medicare Advantage marketing emails. Compliance reviews every email before it is sent to members.");
  await page.getByRole("button", { name: "Suggest the phrases" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft by intake assistant" })).toContainText("4 phrases");
  const members = page.getByRole("group", { name: "Will members see or interact with it?" }).getByRole("button");
  await expect(members).toHaveAttribute("aria-label", /^Yes: see/);
  await expect(members).toHaveAttribute("data-suggested", "true");
  await expect(page.getByText("Provisional · 2 left")).toBeVisible();
  for (const question of ["Does it use protected health information?", "Is the model or service hosted by a vendor?"]) {
    await page.getByRole("group", { name: question }).getByRole("button", { name: /^No: / }).click();
  }
  await expect(page.getByTestId("verdict")).toContainText("Medium risk");
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page).toHaveURL(/\/registry\/[0-9a-f-]{36}$/);
  const asset = page.url();

  // Reviewer: the drafter's draft waits at the Security seat; sign it as drafted.
  await actAs(page, "Rowan Ellis");
  await page.goto(asset);
  await expect(page.getByText("The review drafter is drafting")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByText(/^Your next step/).locator("..")).toContainText("drafts ready");
  await page.getByRole("link", { name: /^Security: Your seat · draft ready/ }).click();
  const panel = page.getByRole("complementary");
  const draft = panel.getByRole("region", { name: "Draft by review drafter" });
  await expect(draft).toContainText("Draft only · cannot approve");
  await expect(draft.getByRole("button", { name: /Approve|Sign/ })).toHaveCount(0);
  await expect(panel.getByLabel("Memo for the approver, from the draft")).toHaveValue(/Security review of Marketing email drafter/);
  await panel.getByRole("button", { name: /^Sign (with|without)/ }).click();
  await expect(page.getByRole("link", { name: /^Security: / })).toHaveAttribute("aria-label", "Security: Signed by Rowan Ellis");

  await page.goto(`${asset}?tab=history`);
  await expect(page.locator(".timeline li", { hasText: "Rowan Ellis signed Security, keeping the drafter's memo" })).toBeVisible();
  await expect(page.locator(".timeline li", { hasText: "drafted the Security review" }).first()).toContainText("AI agent · draft only");
  await expect(page.locator(".timeline li", { hasText: "Riley Park submitted the intake, keeping 4 of 4 suggested answers" })).toBeVisible();

  // Reviewers see the agents but cannot switch them.
  await rail(page, "Agents").click();
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

  // With the intake assistant off, nobody offers to suggest phrases.
  await actAs(page, "Riley Park");
  await rail(page, "Intake").click();
  await expect(page.getByLabel("What is it called?")).toBeVisible();
  await expect(page.getByRole("button", { name: "Suggest the phrases" })).toHaveCount(0);
});
