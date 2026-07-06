import { describe, expect, it } from "bun:test";

import { decrypt as decryptShared, encrypt as encryptShared, generateUserId as generateSharedUserId } from "../../../shared/crypto.ts";
import * as browserCrypto from "../../../web/crypto.js";
import { LARGE_PLAINTEXT, PRIMARY_CREDENTIALS, SAMPLE_ENVELOPE_PLAINTEXT } from "../helpers/fixtures.ts";

describe("crypto parity", () => {
  it("derives the same mailbox id in shared TypeScript and browser JavaScript", async () => {
    const [sharedUserId, browserUserId] = await Promise.all([
      generateSharedUserId(PRIMARY_CREDENTIALS),
      browserCrypto.generateUserId(PRIMARY_CREDENTIALS),
    ]);

    expect(browserUserId).toBe(sharedUserId);
  });

  it("round-trips ciphertext across the shared and browser implementations", async () => {
    const sharedEncrypted = await encryptShared(SAMPLE_ENVELOPE_PLAINTEXT, PRIMARY_CREDENTIALS);
    const decryptedByBrowser: Uint8Array = await browserCrypto.decrypt(sharedEncrypted, PRIMARY_CREDENTIALS);
    expect(Bun.deepEquals(decryptedByBrowser, SAMPLE_ENVELOPE_PLAINTEXT)).toBe(true);

    const browserEncrypted = await browserCrypto.encrypt(LARGE_PLAINTEXT, PRIMARY_CREDENTIALS);
    const decryptedByShared = await decryptShared(browserEncrypted, PRIMARY_CREDENTIALS);
    expect(Bun.deepEquals(decryptedByShared, LARGE_PLAINTEXT)).toBe(true);
  });

  // Regression test: the old string-based crypto round-tripped plaintext through
  // TextDecoder/TextEncoder, which silently corrupts bytes that aren't valid UTF-8
  // (lone continuation bytes, overlong sequences, etc. get replaced with U+FFFD).
  // Byte-native encrypt()/decrypt() must carry arbitrary binary content unchanged.
  it("round-trips non-UTF8-safe binary bytes byte-for-byte across both implementations", async () => {
    const binaryPayload = new Uint8Array([0x00, 0xff, 0x80, 0xfe, 0x41, 0x00, 0x42, 0xc3, 0x28, 0xff, 0x80]);

    const sharedEncrypted = await encryptShared(binaryPayload, PRIMARY_CREDENTIALS);
    const decryptedByBrowser: Uint8Array = await browserCrypto.decrypt(sharedEncrypted, PRIMARY_CREDENTIALS);
    expect(Bun.deepEquals(decryptedByBrowser, binaryPayload)).toBe(true);

    const browserEncrypted = await browserCrypto.encrypt(binaryPayload, PRIMARY_CREDENTIALS);
    const decryptedByShared = await decryptShared(browserEncrypted, PRIMARY_CREDENTIALS);
    expect(Bun.deepEquals(decryptedByShared, binaryPayload)).toBe(true);
  });
});
