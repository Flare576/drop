import { describe, expect, it } from "bun:test";

import { decrypt as decryptShared, encrypt as encryptShared, generateUserId as generateSharedUserId } from "../../../shared/crypto.ts";
import * as browserCrypto from "../../../web/crypto.js";
import { LARGE_PLAINTEXT, PRIMARY_CREDENTIALS, SAMPLE_ENVELOPE } from "../helpers/fixtures.ts";

describe("crypto parity", () => {
  it("derives the same mailbox id in shared TypeScript and browser JavaScript", async () => {
    const [sharedUserId, browserUserId] = await Promise.all([
      generateSharedUserId(PRIMARY_CREDENTIALS),
      browserCrypto.generateUserId(PRIMARY_CREDENTIALS),
    ]);

    expect(browserUserId).toBe(sharedUserId);
  });

  it("round-trips ciphertext across the shared and browser implementations", async () => {
    const sharedEncrypted = await encryptShared(SAMPLE_ENVELOPE.patch, PRIMARY_CREDENTIALS);
    expect(await browserCrypto.decrypt(sharedEncrypted, PRIMARY_CREDENTIALS)).toBe(SAMPLE_ENVELOPE.patch);

    const browserEncrypted = await browserCrypto.encrypt(LARGE_PLAINTEXT, PRIMARY_CREDENTIALS);
    expect(await decryptShared(browserEncrypted, PRIMARY_CREDENTIALS)).toBe(LARGE_PLAINTEXT);
  });
});
