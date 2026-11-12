import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * A customer tenant signs its people in through its own OpenID Connect
 * provider (a mock here). The admin is added by the platform; everyone else
 * is added by an admin, comes in through the provider, and is switched off
 * by an admin, which signs them out at once.
 */

const ORG = "acme-health";
const run = Date.now().toString(36);

async function signIn(page: Page, email: string, options: { org?: string; name?: string; unverified?: boolean } = {}) {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Organization").fill(options.org ?? ORG);
  await page.getByRole("button", { name: "Continue to your sign-in" }).click();
  await expect(page.getByRole("heading", { name: "Test provider" })).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(email);
  if (options.name) await page.getByLabel("Name", { exact: true }).fill(options.name);
  if (options.unverified) await page.getByLabel("Email not verified").check();
  await page.getByRole("button", { name: "Sign in at the provider" }).click();
}

async function freshPage(browser: Browser) {
  const context = await browser.newContext();
  return context.newPage();
}

test("an admin signs in through the tenant's provider, adds a reviewer, and switches them off", async ({ page, browser }) => {
  await signIn(page, "Ada@Acme-Health.test");
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.locator("details.menu > summary")).toHaveAttribute("aria-label", /^Ada Admin, Admin/);

  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "People" }).click();
  const signInPanel = page.getByRole("region", { name: "Sign-in" });
  await expect(signInPanel.getByRole("heading", { name: "Single sign-on" })).toBeVisible();
  await expect(signInPanel).toContainText("http://localhost:3201");
  await expect(signInPanel).toContainText("http://localhost:3200/sso/callback");
  await expect(signInPanel).toContainText("Only people added here");

  const email = `rowan-${run}@acme-health.test`;
  await page.getByRole("button", { name: "Add a person" }).click();
  const add = page.getByRole("form", { name: "Add a person" });
  await add.getByLabel("Name").fill(`Rowan ${run}`);
  await add.getByLabel("Work email").fill(email);
  await add.getByLabel(/^Requester/).uncheck();
  await add.getByLabel(/^Reviewer/).check();
  await add.getByLabel("Security").check();
  await add.getByRole("button", { name: "Add" }).click();
  // The person's own row; an open editor adds a second row beneath it.
  const row = page.getByRole("row", { name: new RegExp(`Rowan ${run}`) }).first();
  await expect(row).toContainText("Reviewer");
  await expect(row).toContainText("Signs for Security");
  await expect(row).toContainText("Not yet");

  // Rowan comes in through the provider, as the reviewer the admin added.
  const rowan = await freshPage(browser);
  await signIn(rowan, email);
  await expect(rowan).toHaveURL(/\/today$/);
  await expect(rowan.locator("details.menu > summary")).toHaveAttribute("aria-label", new RegExp(`^Rowan ${run}, Reviewer`));
  await expect(rowan.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "People" })).toHaveCount(0);
  await rowan.goto("/people");
  await expect(rowan).toHaveURL(/\/today$/);

  // The admin switches Rowan off; Rowan's next request finds no session.
  await page.reload();
  await row.getByRole("button", { name: `Change Rowan ${run}` }).click();
  await page.getByLabel(/^Switched off/).check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("Switched off");
  await rowan.goto("/registry");
  await expect(rowan).toHaveURL(/\/$/);
  await signIn(rowan, email);
  await expect(rowan.locator("p[role=alert]")).toHaveText(/switched off/);
});

test("the provider's word is not enough: unknown organizations, strangers, other domains and unverified addresses stay out", async ({
  page,
}) => {
  await page.goto("/signin");
  await page.getByLabel("Organization").fill("no-such-org");
  await page.getByRole("button", { name: "Continue to your sign-in" }).click();
  await expect(page.locator("p[role=alert]")).toHaveText(/No organization by that name/);

  await signIn(page, `stranger-${run}@acme-health.test`);
  await expect(page).toHaveURL(/\/signin\?/);
  await expect(page.locator("p[role=alert]")).toHaveText(/haven't been added/);

  await signIn(page, "eve@evil.test");
  await expect(page.locator("p[role=alert]")).toHaveText(/verified work email/);

  await signIn(page, "ada@acme-health.test", { unverified: true });
  await expect(page.locator("p[role=alert]")).toHaveText(/verified work email/);

  // A replayed or forged callback finds no sign-in under way.
  await page.goto("/sso/callback?code=stolen&state=guessed");
  await expect(page.locator("p[role=alert]")).toHaveText(/took too long or was already used/);
});
