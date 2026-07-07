import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

import { encrypt } from "../../shared/crypto.ts";
import { PRIMARY_CREDENTIALS, SAMPLE_CONTENT, SAMPLE_ENVELOPE_PLAINTEXT, SAMPLE_FILENAME } from "../bun/helpers/fixtures.ts";

const API_BASE = "http://relay.test/api";
const DELETE_ERROR = "Relay refused delete. Artifact still present.";

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

test("downloads the decrypted artifact bytes, deletes the relay copy, and refreshes to an empty inbox after confirmation", async ({ page }) => {
  const encryptedArtifact = await encrypt(SAMPLE_ENVELOPE_PLAINTEXT, PRIMARY_CREDENTIALS);
  let deleted = false;
  let sawConfirmDialog = false;
  const confirmHandled = new Promise<void>((resolve) => {
    page.once("dialog", async (dialog) => {
      sawConfirmDialog = true;
      await dialog.accept();
      resolve();
    });
  });

  await page.route(`${API_BASE}/**`, async (route) => {
    const request = route.request();
    const segments = new URL(request.url()).pathname.split("/").filter(Boolean);

    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }

    if (request.method() === "GET" && segments.length === 2) {
      await route.fulfill(
        jsonResponse({
          items: deleted
            ? []
            : [
                {
                  artifactId: "artifact-1",
                  createdAt: "2026-07-03T12:00:00.000Z",
                  sizeBytes: 128,
                },
              ],
        }),
      );
      return;
    }

    if (request.method() === "GET" && segments.length === 3) {
      await route.fulfill(jsonResponse(encryptedArtifact));
      return;
    }

    if (request.method() === "DELETE" && segments.length === 3) {
      deleted = true;
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }

    throw new Error(`Unexpected request in delete-failure.spec.ts: ${request.method()} ${request.url()}`);
  });

  await page.goto(`/?apiBase=${encodeURIComponent(API_BASE)}`);
  await signIn(page);

  await expect(page.locator("#list-status")).toHaveText("1 item waiting.");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  const download = await downloadPromise;
  await confirmHandled;

  expect(sawConfirmDialog).toBe(true);
  expect(download.suggestedFilename()).toBe(SAMPLE_FILENAME);

  const downloadPath = test.info().outputPath(SAMPLE_FILENAME);
  await download.saveAs(downloadPath);
  expect(new Uint8Array(await readFile(downloadPath))).toEqual(SAMPLE_CONTENT);

  await expect(page.locator("#list-status")).toHaveText(`Deleted "${SAMPLE_FILENAME}" from the server.`);
  await expect(page.locator("#list-status")).toHaveClass(/success/);
  await expect(page.getByRole("button", { name: "Download" })).toHaveCount(0);
  await expect(page.locator("#artifact-list")).toContainText("No artifacts waiting.");
});

test("surfaces the relay error when delete fails after a successful download instead of claiming the artifact was removed", async ({ page }) => {
  const encryptedArtifact = await encrypt(SAMPLE_ENVELOPE_PLAINTEXT, PRIMARY_CREDENTIALS);

  await page.route(`${API_BASE}/**`, async (route) => {
    const request = route.request();
    const segments = new URL(request.url()).pathname.split("/").filter(Boolean);

    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }

    if (request.method() === "GET" && segments.length === 2) {
      await route.fulfill(
        jsonResponse({
          items: [
            {
              artifactId: "artifact-1",
              createdAt: "2026-07-03T12:00:00.000Z",
              sizeBytes: 128,
            },
          ],
        }),
      );
      return;
    }

    if (request.method() === "GET" && segments.length === 3) {
      await route.fulfill(jsonResponse(encryptedArtifact));
      return;
    }

    if (request.method() === "DELETE" && segments.length === 3) {
      await route.fulfill(jsonResponse({ error: DELETE_ERROR }, 500));
      return;
    }

    throw new Error(`Unexpected request in delete-failure.spec.ts: ${request.method()} ${request.url()}`);
  });

  await page.goto(`/?apiBase=${encodeURIComponent(API_BASE)}`);
  await signIn(page);

  await expect(page.locator("#list-status")).toHaveText("1 item waiting.");

  page.once("dialog", async (dialog) => {
    await dialog.accept();
  });

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  await download;

  await expect(page.locator("#list-status")).toHaveText(DELETE_ERROR);
  await expect(page.locator("#list-status")).toHaveClass(/error/);
  await expect(page.locator("#list-status")).not.toContainText("Deleted \"");
  await expect(page.getByRole("button", { name: "Download" })).toBeEnabled();
  await expect(page.locator("#artifact-list")).not.toContainText("No artifacts waiting.");
});
