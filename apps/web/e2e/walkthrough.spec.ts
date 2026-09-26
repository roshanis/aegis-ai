import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

/**
 * The whole path through the real UI: a visitor opens a sandbox, a
 * requester files a system as one sentence, reviewers sign their seats at
 * the table, an approver decides with conditions, an admin puts it in use,
 * and an auditor finds who approved it, why, under which rule, and exports
 * the evidence pack.
 */

const person = (page: Page) => page.locator("details.menu > summary");

async function actAs(page: Page, name: string) {
  await person(page).click();
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await expect(person(page)).toHaveAttribute("aria-label", new RegExp(`^${name},`));
}

async function openSandbox(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open a sandbox" }).click();
  // Seeding runs the agents' golden sets and drafts, which takes a few seconds.
  await expect(page).toHaveURL(/\/today$/, { timeout: 30_000 });
}

/** Settle one phrase of the intake sentence. */
async function phrase(page: Page, question: string, yes: boolean) {
  await page
    .getByRole("group", { name: question })
    .getByRole("button", { name: yes ? /^Yes: / : /^No: / })
    .click();
}

const seat = (page: Page, domain: string) => page.getByRole("link", { name: new RegExp(`^${domain}: `) });

test("an AI system goes from a one-sentence intake through the table to use, and the audit log proves it", async ({ page }) => {
  await openSandbox(page);
  await expect(page.getByRole("heading", { name: "The Aegis Docket" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waiting for you" })).toBeVisible();

  // Requester: the intake is one sentence, triaged live by the pack's rules.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Intake" }).click();
  await page.getByLabel("What is it called?").fill("Benefits FAQ assistant");
  await page.getByLabel("What does it do? In your words").fill("answer members' benefits questions");
  await phrase(page, "Does it use protected health information?", false);
  await phrase(page, "Will members see or interact with it?", true);
  await expect(page.getByTestId("verdict")).toHaveText("Medium risk, because it is in front of members.");
  await phrase(page, "Could it influence care or coverage decisions?", false);
  await phrase(page, "Does a person review every output before it takes effect?", true);
  await phrase(page, "Is the model or service hosted by a vendor?", false);
  await phrase(page, "Could it materially affect an individual?", false);
  // A settled phrase flips when selected, and flips back.
  const members = page.getByRole("group", { name: "Will members see or interact with it?" });
  await members.getByRole("button", { name: /^Yes: see/ }).click();
  await expect(page.getByTestId("verdict")).toContainText("Low risk");
  await members.getByRole("button", { name: /^No: never see/ }).click();
  await expect(page.getByText("5 teams will review it: Data Governance, Legal, Responsible AI, Security, Tech Architecture.")).toBeVisible();
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page).toHaveURL(/\/registry\/[0-9a-f-]{36}$/);
  const asset = page.url();
  await expect(page.getByText("CASE-0008 · Initial review · In review")).toBeVisible();
  await expect(page.getByText("Add evidence for 3 controls")).toBeVisible();

  // Requester: evidence for the three gate controls.
  await page.goto(`${asset}?tab=controls`);
  for (const [id, title] of [["D-01", "Lineage document"], ["R-01", "Fairness test report"], ["T-01", "Architecture review minutes"]]) {
    const control = page.locator(`article#${id}`);
    await control.getByRole("button", { name: "Add evidence" }).click();
    await control.getByLabel("Title").fill(title!);
    await control.getByLabel("Link").fill(`https://docs.example.test/${id}`);
    await control.getByRole("button", { name: "Add this evidence" }).click();
    await expect(control.getByText("Evidenced")).toBeVisible();
  }

  // Reviewers take their seats at the table and sign from the drafter's drafts.
  for (const [reviewer, domains] of [
    ["Rowan Ellis", ["Data Governance", "Security", "Tech Architecture"]],
    ["Jordan Lee", ["Legal", "Responsible AI"]],
  ] as const) {
    await actAs(page, reviewer);
    await page.goto(asset);
    // The review drafter works in the background; the page refreshes itself until its drafts land.
    await expect(page.getByText("The review drafter is drafting")).toHaveCount(0, { timeout: 20_000 });
    for (const domain of domains) {
      await seat(page, domain).click();
      await expect(page.getByRole("heading", { level: 2, name: domain })).toBeVisible();
      const panel = page.getByRole("complementary");
      await expect(panel.getByRole("region", { name: "Draft by review drafter" })).toContainText("Draft only · cannot approve");
      await panel.getByRole("button", { name: /^Sign (with|without)/ }).click();
      await expect(seat(page, domain)).toHaveAttribute("aria-label", `${domain}: Signed by ${reviewer}`);
    }
  }

  // Approver: the decision seat, with the reviewers' conditions filled in.
  await actAs(page, "Avery Brooks");
  await page.goto(asset);
  await expect(page.getByRole("heading", { level: 2, name: "The decision" })).toBeVisible();
  await expect(page.getByText("All required reviews signed; ready for approval.").first()).toBeVisible();
  // The reviewers signed from the drafts, which proposed a condition for each monitor control.
  await expect(page.locator(".condition-row")).toHaveCount(3);
  await page.getByLabel("Condition 1", { exact: true }).fill("Show members an AI disclosure before the first answer");
  for (const n of [2, 3]) {
    await page.getByRole("group", { name: `When condition ${n} is due` }).getByRole("button", { name: "Ongoing" }).click();
  }
  await page.getByLabel(/^Reason/).fill("Fine for members once the AI disclosure is live.");
  await page.getByRole("button", { name: "Approve with 3 conditions" }).click();
  await expect(page.getByRole("region", { name: "Clearance" })).toContainText("1 condition must be met before use");
  await expect(seat(page, "Decision")).toHaveAttribute("aria-label", "Decision: Approved with conditions");

  // Requester shows the condition is met; the approver accepts it.
  await actAs(page, "Riley Park");
  await page.goto(`${asset}?tab=conditions`);
  const condition = page.getByRole("article", { name: "Show members an AI disclosure before the first answer" });
  await condition.getByRole("button", { name: "Add evidence" }).click();
  await condition.getByRole("button", { name: "Written attestation" }).click();
  await condition.getByLabel("Title").fill("Disclosure live");
  await condition.getByLabel("What you attest to").fill("The disclosure banner shipped in release 4.2.");
  await condition.getByRole("button", { name: "Add this evidence" }).click();
  await condition.getByRole("button", { name: "Submit for acceptance" }).click();
  await condition.getByRole("button", { name: "Submit for acceptance" }).click();
  await expect(condition.getByText("Evidence submitted")).toBeVisible();

  await actAs(page, "Avery Brooks");
  await page.goto(`${asset}?tab=conditions`);
  await condition.getByRole("button", { name: "Accept" }).click();
  await condition.getByRole("button", { name: "Accept" }).click();
  await expect(condition.getByText("Met", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Clearance" })).toContainText("Cleared for use.");

  // Admin puts it in use.
  await actAs(page, "Ada Morgan");
  await page.goto(asset);
  await page.getByRole("button", { name: "Put in use" }).click();
  await page.getByRole("button", { name: "Put in use" }).click();
  await expect(page.locator(".case-head .tag").first()).toHaveText("In use");

  // Auditor: who decided, why, under which policy; and nothing to click.
  await actAs(page, "Aubrey Kim");
  await page.goto(`${asset}?tab=history`);
  const decision = page.locator(".timeline li[data-decision='true']").first();
  await expect(decision).toContainText("Avery Brooks approved it with conditions");
  await expect(decision).toContainText("Fine for members once the AI disclosure is live.");
  await expect(decision).toContainText("healthcare-ai@1.3.0");
  await expect(page.locator(".timeline li", { hasText: "Jordan Lee signed Responsible AI" })).toBeVisible();
  await expect(page.locator("main button")).toHaveCount(0);

  // The audit log answers by case number, and exports the evidence pack.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Audit" }).click();
  await page.getByLabel("Search the audit log").fill("CASE-0008");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const answer = page.getByRole("region", { name: /Conditionally approved/ });
  await expect(answer).toContainText("Conditionally approved by Avery Brooks");
  await expect(answer).toContainText("member-facing · Medium risk");
  await expect(answer).toContainText("5 of 5 signed");
  await expect(page.getByText(/^Hash chain verified/)).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), answer.getByRole("link", { name: "Export evidence pack" }).click()]);
  expect(download.suggestedFilename()).toBe("CASE-0008-evidence-pack.json");
  const pack = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(pack).toMatchObject({
    case: { label: "CASE-0008", policy: "healthcare-ai@1.3.0", tierRule: { id: "member-facing" } },
    decision: { state: "conditionally_approved", by: { name: "Avery Brooks" } },
    chain: { intact: true },
  });
});

test("⌘K jumps to a system, and a person can pin a theme", async ({ page }) => {
  await openSandbox(page);
  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByRole("combobox", { name: "Search cases, systems and pages" });
  await search.fill("chat");
  await expect(page.getByRole("option", { name: /Member benefits chat assistant/ })).toBeVisible();
  await search.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Member benefits chat assistant" })).toBeVisible();

  await person(page).click();
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("a session cookie edited to become the admin gets no one in", async ({ page, context }) => {
  await openSandbox(page);
  // A real person in the same tenant, so only the signature stands in the way.
  const admin = await page.locator("input[name='userId']").first().inputValue();
  const [session] = (await context.cookies()).filter((c) => c.name === "aegis_session");
  const [body, signature] = session!.value.split(".");
  const payload = JSON.parse(Buffer.from(body!, "base64url").toString());
  expect(payload.u).not.toBe(admin);
  const forged = Buffer.from(JSON.stringify({ ...payload, u: admin })).toString("base64url");
  await context.addCookies([{ ...session!, value: `${forged}.${signature}` }]);
  await page.goto("/registry");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: "Open a sandbox" })).toBeVisible();
});
