import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { decrypt, generateUserId } from "../../../shared/crypto.ts";
import { PRIMARY_CREDENTIALS } from "../helpers/fixtures.ts";
import { startCaptureServer } from "../helpers/temp-server.ts";
import { TempRepo } from "../helpers/temp-repo.ts";

const CLI_PATH = fileURLToPath(new URL("../../../cli/push.ts", import.meta.url));
const DROP_AUTH = "drop-auth-for-tests";

interface PushRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runPush(repoDir: string, apiBase: string, extraArgs: string[]): Promise<PushRunResult> {
  const subprocess = Bun.spawn(
    [
      process.execPath,
      "run",
      CLI_PATH,
      "--username",
      PRIMARY_CREDENTIALS.username,
      "--passphrase",
      PRIMARY_CREDENTIALS.passphrase,
      "--drop-auth",
      DROP_AUTH,
      "--api-base",
      apiBase,
      ...extraArgs,
    ],
    {
      cwd: repoDir,
      env: {
        ...process.env,
        HOME: repoDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

/** Decrypts a captured request body and parses out the header+NUL+content envelope. */
async function decryptEnvelope(bodyText: string): Promise<{ filename: string; content: Uint8Array }> {
  const encryptedBody = JSON.parse(bodyText) as { iv: string; ciphertext: string };
  const plaintextBytes = await decrypt(encryptedBody, PRIMARY_CREDENTIALS);

  const sep = plaintextBytes.indexOf(0);
  const header = JSON.parse(new TextDecoder().decode(plaintextBytes.slice(0, sep))) as { filename: string };
  const content = plaintextBytes.slice(sep + 1);

  return { filename: header.filename, content };
}

describe("push.ts --input", () => {
  it("pushes the exact raw bytes of a non-UTF8 binary file, defaulting the filename to its basename", async () => {
    const repo = await TempRepo.create("drop-push-input-");
    const captureServer = await startCaptureServer();

    try {
      const binaryBytes = new Uint8Array([0x00, 0xff, 0x80, 0x41, 0x42, 0xfe, 0x00, 0x43, 0xc3, 0x28]);
      const inputPath = join(repo.dir, "payload.bin");
      await Bun.write(inputPath, binaryBytes);

      const result = await runPush(repo.dir, captureServer.baseUrl, ["--input", inputPath]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Push succeeded:");

      expect(captureServer.requests).toHaveLength(1);
      const [request] = captureServer.requests;
      expect(request.method).toBe("POST");
      expect(request.url).toBe(`${captureServer.baseUrl}/${await generateUserId(PRIMARY_CREDENTIALS)}`);

      const envelope = await decryptEnvelope(request.bodyText);
      expect(envelope.filename).toBe("payload.bin");
      expect(Bun.deepEquals(envelope.content, binaryBytes)).toBe(true);
    } finally {
      await captureServer.stop();
      await repo.destroy();
    }
  });

  it("overrides the default basename-derived filename with --filename", async () => {
    const repo = await TempRepo.create("drop-push-input-");
    const captureServer = await startCaptureServer();

    try {
      const inputPath = join(repo.dir, "source.txt");
      await repo.write("source.txt", "hello from --input\n");

      const result = await runPush(repo.dir, captureServer.baseUrl, ["--input", inputPath, "--filename", "renamed.txt"]);

      expect(result.exitCode).toBe(0);
      expect(captureServer.requests).toHaveLength(1);

      const envelope = await decryptEnvelope(captureServer.requests[0].bodyText);
      expect(envelope.filename).toBe("renamed.txt");
      expect(new TextDecoder().decode(envelope.content)).toBe("hello from --input\n");
    } finally {
      await captureServer.stop();
      await repo.destroy();
    }
  });

  it("exits 1, names the missing path on stderr, and never contacts the relay when --input points at a nonexistent file", async () => {
    const repo = await TempRepo.create("drop-push-input-");
    const captureServer = await startCaptureServer();

    try {
      const missingPath = join(repo.dir, "does-not-exist.bin");

      const result = await runPush(repo.dir, captureServer.baseUrl, ["--input", missingPath]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`push.ts: --input file not found: ${missingPath}`);
      expect(captureServer.requests).toHaveLength(0);
    } finally {
      await captureServer.stop();
      await repo.destroy();
    }
  });

  it("still pushes a 0-byte --input file instead of skipping with 'Nothing to push'", async () => {
    const repo = await TempRepo.create("drop-push-input-");
    const captureServer = await startCaptureServer();

    try {
      const emptyPath = join(repo.dir, "empty.bin");
      await Bun.write(emptyPath, new Uint8Array(0));

      const result = await runPush(repo.dir, captureServer.baseUrl, ["--input", emptyPath]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("Nothing to push");
      expect(result.stdout).toContain("Push succeeded:");
      expect(captureServer.requests).toHaveLength(1);

      const envelope = await decryptEnvelope(captureServer.requests[0].bodyText);
      expect(envelope.filename).toBe("empty.bin");
      expect(envelope.content.length).toBe(0);
    } finally {
      await captureServer.stop();
      await repo.destroy();
    }
  });
});
