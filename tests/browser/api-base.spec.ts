import { expect, test, type Page } from "@playwright/test";

import { PRIMARY_CREDENTIALS } from "../bun/helpers/fixtures.ts";

const LOCAL_OVERRIDE_BASE = "http://relay.test/drop/api";
const HOSTILE_OVERRIDE_BASE = "http://evil.test/drop/api";
const PRODUCTION_BASE = "https://flare576.com/drop/api";

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

test("honors a localhost-only apiBase override so the static page can talk to a local relay", async ({ page }) => {
  await page.route(`${LOCAL_OVERRIDE_BASE}/**`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }

    await route.fulfill(
      jsonResponse({
        items: [
          {
            artifactId: "artifact-local",
            createdAt: "2026-07-03T12:00:00.000Z",
            sizeBytes: 128,
          },
        ],
      }),
    );
  });

  await page.route(`${PRODUCTION_BASE}/**`, async (route) => {
    await route.fulfill(jsonResponse({ error: "should not hit production during localhost override test" }, 500));
  });

  await page.goto(`/?apiBase=${encodeURIComponent(LOCAL_OVERRIDE_BASE)}`);
  await signIn(page);

  await expect(page.locator("#list-status")).toHaveText("1 item waiting.");
  await expect(page.getByRole("button", { name: "Download" })).toBeVisible();
  await expect(page.locator("#artifact-list")).not.toContainText("No artifacts waiting.");
});

test("ignores a hostile apiBase override on non-localhost pages and keeps the inbox bound to the hardcoded relay", async ({ page }) => {
  await page.route(`${HOSTILE_OVERRIDE_BASE}/**`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }

    await route.fulfill(
      jsonResponse({
        items: [
          {
            artifactId: "artifact-evil",
            createdAt: "2026-07-03T12:00:00.000Z",
            sizeBytes: 128,
          },
        ],
      }),
    );
  });

  await page.route(`${PRODUCTION_BASE}/**`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }

    await route.fulfill(jsonResponse({ items: [] }));
  });

  await page.goto(`http://drop.localhost:8082/?apiBase=${encodeURIComponent(HOSTILE_OVERRIDE_BASE)}`);
  await signIn(page);

  await expect(page.locator("#artifact-list")).toContainText("No artifacts waiting.");
  await expect(page.locator("#list-status")).toHaveText("");
  await expect(page.getByRole("button", { name: "Download" })).toHaveCount(0);
});
