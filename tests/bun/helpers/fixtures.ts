export interface TestCredentials {
  username: string;
  passphrase: string;
}

export interface TestArtifactEnvelope {
  filename: string;
  patch: string;
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

export const SAMPLE_ENVELOPE: TestArtifactEnvelope = {
  filename: "demo.patch",
  patch: "diff --git a/demo.txt b/demo.txt\nnew file mode 100644\nindex 0000000..ce01362\n--- /dev/null\n+++ b/demo.txt\n@@ -0,0 +1 @@\n+hello world\n",
};

export const LARGE_PLAINTEXT = JSON.stringify({
  items: Array.from({ length: 700 }, (_, index) => ({
    id: index,
    label: `Artifact ${index} with enough text to exercise chunked base64 conversion`,
    bytes: index * 17,
  })),
});
