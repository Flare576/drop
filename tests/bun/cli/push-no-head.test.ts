import { describe, expect, it } from "bun:test";
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

async function runPush(repoDir: string, apiBase: string): Promise<PushRunResult> {
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

describe("push.ts in a repo without HEAD", () => {
  it("pushes one encrypted patch from a freshly initialized repo that only has an untracked file", async () => {
    const repo = await TempRepo.create("drop-push-no-head-");
    const captureServer = await startCaptureServer();

    try {
      await repo.write("notes/hello.txt", "hello from a repo without HEAD\n");

      const result = await runPush(repo.dir, captureServer.baseUrl);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Push succeeded:");

      expect(captureServer.requests).toHaveLength(1);
      const [request] = captureServer.requests;

      expect(request.method).toBe("POST");
      expect(request.headers["content-type"]).toBe("application/json");
      expect(request.headers["x-drop-auth"]).toBe(DROP_AUTH);
      expect(request.url).toBe(`${captureServer.baseUrl}/${await generateUserId(PRIMARY_CREDENTIALS)}`);

      const encryptedBody = JSON.parse(request.bodyText) as { iv: string; ciphertext: string };
      const envelopeJson = await decrypt(encryptedBody, PRIMARY_CREDENTIALS);
      const envelope = JSON.parse(envelopeJson) as { filename: string; patch: string };

      expect(envelope.filename).toEndWith(".patch");
      expect(envelope.patch).toContain("diff --git a/notes/hello.txt b/notes/hello.txt");
      expect(envelope.patch).toContain("new file mode 100644");
      expect(envelope.patch).toContain("+++ b/notes/hello.txt");
      expect(envelope.patch).toContain("+hello from a repo without HEAD");
    } finally {
      await captureServer.stop();
      await repo.destroy();
    }
  });
});
