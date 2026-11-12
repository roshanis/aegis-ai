import { expect, test, type Page } from "@playwright/test";

/**
 * The evidence API: an admin makes a key on the People page, a pipeline
 * posts a test run to a control with it, the run shows on the control as
 * posted by that key, and a revoked key is refused.
 */

const person = (page: Page) => page.locator("details.menu > summary");

async function actAs(page: Page, name: string) {
  await person(page).click();
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await expect(person(page)).toHaveAttribute("aria-label", new RegExp(`^${name},`));
}

test("a pipeline posts evidence with an API key, and a revoked key is refused", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open a sandbox" }).click();
  await expect(page).toHaveURL(/\/today$/, { timeout: 30_000 });
  await actAs(page, "Ada Morgan");

  await page.goto("/people");
  const keys = page.getByRole("region", { name: "API keys" });
  await keys.getByLabel("Which tool will use it?").fill("Fairness test pipeline");
  await keys.getByRole("button", { name: "Make a key" }).click();
  const key = (await keys.getByTestId("new-key").textContent())!.trim();
  expect(key).toMatch(/^aek\./);
  await expect(keys.getByText(/never used/)).toBeVisible();

  await page.goto("/registry");
  await page.getByRole("link", { name: "Member benefits chat assistant" }).click();
  await expect(page).toHaveURL(/\/registry\/[0-9a-f-]{36}/);
  const assetId = page.url().split("/registry/")[1]!.split("?")[0]!;

  const post = (token: string, body: unknown) =>
    request.post("/api/v1/evidence", { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, data: body });
  const run = { assetId, controlId: "R-01", title: "Fairness run 4812", url: "https://ci.northwind.example/runs/4812" };

  expect((await post(key, { ...run, controlId: "NOPE-9" })).status()).toBe(422);
  expect((await request.post("/api/v1/evidence", { headers: { Authorization: `Bearer ${key}` }, data: "not json" })).status()).toBe(400);
  const made = await post(key, run);
  expect(made.status()).toBe(201);
  expect(await made.json()).toMatchObject({ id: expect.stringMatching(/^[0-9a-f-]{36}$/) });

  await page.goto(`/registry/${assetId}?tab=controls`);
  const control = page.locator("article#R-01");
  await expect(control.getByRole("link", { name: "Fairness run 4812" })).toBeVisible();
  await expect(control.getByText(/Posted by Fairness test pipeline, a key of Ada/)).toBeVisible();

  await page.goto("/people");
  await expect(keys.getByText(/last used/)).toBeVisible();
  await keys.getByRole("button", { name: "Revoke Fairness test pipeline" }).click();
  await keys.getByRole("button", { name: "Revoke Fairness test pipeline now" }).click();
  await expect(keys.getByText("Revoked")).toBeVisible();
  const refused = await post(key, run);
  expect(refused.status()).toBe(401);
  expect(await refused.json()).toEqual({ error: "that API key is not valid" });
});
