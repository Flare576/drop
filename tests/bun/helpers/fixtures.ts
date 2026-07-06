export interface TestCredentials {
  username: string;
  passphrase: string;
}

export const PRIMARY_CREDENTIALS: TestCredentials = {
  username: "alice",
  passphrase: "hunter2",
};

export const SECONDARY_CREDENTIALS: TestCredentials = {
  username: "alice",
  passphrase: "different-passphrase",
};

export const TERTIARY_CREDENTIALS: TestCredentials = {
  username: "bob",
  passphrase: "hunter2",
};

// ---------------------------------------------------------------------------------
// Byte-native envelope fixtures.
//
// shared/crypto.ts's encrypt()/decrypt() only ever see opaque plaintext bytes — the
// header+NUL+content envelope is built/parsed by callers (cli/push.ts, web/app.js),
// not by crypto.ts itself. buildEnvelopePlaintext() mirrors that exact construction
// (`JSON.stringify({filename}) + "\0"` followed by raw content bytes) so tests that
// need a REAL artifact — not just arbitrary bytes — exercise the true wire format.
// ---------------------------------------------------------------------------------

export function buildEnvelopePlaintext(filename: string, content: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode(JSON.stringify({ filename }) + "\0");
  const plaintext = new Uint8Array(header.length + content.length);
  plaintext.set(header, 0);
  plaintext.set(content, header.length);
  return plaintext;
}

export const SAMPLE_FILENAME = "demo.patch";

export const SAMPLE_CONTENT = new TextEncoder().encode(
  "diff --git a/demo.txt b/demo.txt\nnew file mode 100644\nindex 0000000..ce01362\n--- /dev/null\n+++ b/demo.txt\n@@ -0,0 +1 @@\n+hello world\n",
);

/** A real, correctly-shaped header+NUL+content envelope — ready to pass straight into encrypt(). */
export const SAMPLE_ENVELOPE_PLAINTEXT = buildEnvelopePlaintext(SAMPLE_FILENAME, SAMPLE_CONTENT);

export const LARGE_PLAINTEXT = new TextEncoder().encode(
  JSON.stringify({
    items: Array.from({ length: 700 }, (_, index) => ({
      id: index,
      label: `Artifact ${index} with enough text to exercise chunked base64 conversion`,
      bytes: index * 17,
    })),
  }),
);
