import { expect, test, type Page } from "@playwright/test";

/**
 * The agent and MCP tool inventory: an agent's owner imports an MCP
 * server's tools after the agent was approved, sees that it lost its
 * clearance because of them, and removes them again; the inventory page
 * lists every agent's tools.
 */

const person = (page: Page) => page.locator("details.menu > summary");

async function actAs(page: Page, name: string) {
  await person(page).click();
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await expect(person(page)).toHaveAttribute("aria-label", new RegExp(`^${name},`));
}

const MANIFEST = JSON.stringify({
  tools: [
    { name: "get_member_letters", annotations: { readOnlyHint: true } },
    { name: "send_member_letter", description: "Mail a letter to a member" },
  ],
});

test("tools added after approval take an agent's clearance away until they are reviewed or removed", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open a sandbox" }).click();
  await expect(page).toHaveURL(/\/today$/, { timeout: 30_000 });
  await actAs(page, "Riley Park");

  await page.goto("/registry/tools");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("What the agents can reach");
  const inventory = page.getByRole("region", { name: "Agent tools" });
  await expect(inventory.getByRole("row")).toHaveCount(7);
  await page.getByRole("link", { name: /^Changes data/ }).click();
  await expect(inventory.getByRole("row")).toHaveCount(2);
  await page.getByRole("link", { name: /^All/ }).click();
  await inventory.getByRole("link", { name: "Provider directory assistant" }).first().click();
  await expect(page).toHaveURL(/\?tab=tools$/);
  const tools = page.url();
  await expect(page.getByText("2 tools on 1 server: 0 change data, 0 act outside, 0 see PHI.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Clearance" })).toContainText("Cleared for use.");

  // The owner imports a letters server; the preview reads the annotations.
  await page.getByRole("button", { name: "Import an MCP server" }).click();
  await expect(page.getByText(/a tool added now takes away its clearance/)).toBeVisible();
  await page.getByLabel("Server name").fill("member-letters");
  await page.getByLabel("Its tools/list result").fill(MANIFEST);
  await page.getByLabel("This server can see members' health information").check();
  await expect(page.getByText("2 tools: 1 reads, 1 acts outside")).toBeVisible();
  await page.getByRole("button", { name: "Import 2 tools" }).click();

  const letters = page.getByRole("region", { name: "member-letters" });
  await expect(letters.getByText("Added after approval")).toHaveCount(2);
  await expect(page.getByText("2 tools added after its approval.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Clearance" })).toContainText(
    "2 tools were added after its approval and need a re-review: member-letters/get_member_letters, member-letters/send_member_letter",
  );

  // Taking them away again never needs a review.
  await page.getByRole("button", { name: "Remove member-letters/send_member_letter" }).click();
  await expect(letters.getByText("Added after approval")).toHaveCount(1);
  await page.getByRole("button", { name: "Remove member-letters/get_member_letters" }).click();
  await expect(page.getByRole("region", { name: "member-letters" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Clearance" })).toContainText("Cleared for use.");

  // A reviewer sees the tools but cannot change them.
  await actAs(page, "Rowan Ellis");
  await page.goto(tools);
  await expect(page.getByText("2 tools on 1 server", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import an MCP server" })).toHaveCount(0);
});
