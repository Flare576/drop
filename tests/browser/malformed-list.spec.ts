import { expect, test, type Page } from "@playwright/test";

import { PRIMARY_CREDENTIALS } from "../bun/helpers/fixtures.ts";

const API_BASE = "http://relay.test/api";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, DELETE, OPTIONS",
  "access-control-allow-headers": "*",
};

function jsonResponse(body: unknown, status = 200) {
  return {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

async function signIn(page: Page) {
  await page.getByLabel("Username").fill(PRIMARY_CREDENTIALS.username);
  await page.getByLabel("Passphrase").fill(PRIMARY_CREDENTIALS.passphrase);
  await page.getByRole("button", { name: "Sign In" }).click();
}

test("shows a visible error when the relay returns a malformed list payload instead of masquerading as an empty inbox", async ({ page }) => {
  await page.route(`${API_BASE}/**`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }

    await route.fulfill(jsonResponse({ items: null }));
  });

  await page.goto(`/?apiBase=${encodeURIComponent(API_BASE)}`);
  await signIn(page);

  await expect(page.locator("#list-status")).toHaveClass(/error/);
  await expect(page.locator("#list-status")).not.toHaveText("");
  await expect(page.locator("#artifact-list")).not.toContainText("No artifacts waiting.");
});
