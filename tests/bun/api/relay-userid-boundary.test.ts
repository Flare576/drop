import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { startDockerStack, type DockerStackHandle } from "../helpers/docker-stack";

const POST_AUTH_CODE = "dev-local-only";

let stack: DockerStackHandle | undefined;

function makeUserId(length: number): string {
  const seed = crypto.randomUUID().replaceAll("-", "");
  return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
}

async function countUserArtifactFiles(userId: string): Promise<number> {
  if (!stack) {
    throw new Error("Docker stack was not started");
  }

  const shard = userId.slice(0, 2);
  const artifactDir = `/tmp/drop-data/${shard}/${userId}`;
  const subprocess = Bun.spawn(
    [
      "docker",
      "compose",
      "exec",
      "-T",
      "api",
      "sh",
      "-lc",
      `if [ -d ${artifactDir} ]; then find ${artifactDir} -type f | wc -l | tr -d '[:space:]'; else echo 0; fi`,
    ],
    {
      cwd: stack.repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const stdout = await new Response(subprocess.stdout).text();
  const stderr = await new Response(subprocess.stderr).text();
  const exitCode = await subprocess.exited;

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `docker compose exec failed (${exitCode})`);
  }

  return Number.parseInt(stdout.trim(), 10);
}

setDefaultTimeout(90_000);

beforeAll(async () => {
  stack = await startDockerStack();
});

afterAll(async () => {
  if (stack) {
    await stack.destroy();
  }
});

test("accepts a 182-character userId, rejects 183 characters, and writes no blob for the rejected request", async () => {
  const acceptedUserId = makeUserId(182);
  const rejectedUserId = makeUserId(183);
  const artifactBody = {
    iv: "AA==",
    ciphertext: "aGVsbG8=",
  };
  const activeStack = stack;
  if (!activeStack) {
    throw new Error("Docker stack was not started");
  }

  const acceptedResponse = await fetch(`${activeStack.baseUrl}/${acceptedUserId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Drop-Auth": POST_AUTH_CODE,
    },
    body: JSON.stringify(artifactBody),
  });

  expect(acceptedResponse.status).toBe(201);

  const acceptedListResponse = await fetch(`${activeStack.baseUrl}/${acceptedUserId}`);
  expect(acceptedListResponse.status).toBe(200);
  const acceptedList = (await acceptedListResponse.json()) as {
    items: Array<{ artifactId: string }>;
  };
  expect(acceptedList.items).toHaveLength(1);
  expect(await countUserArtifactFiles(acceptedUserId)).toBe(1);

  expect(await countUserArtifactFiles(rejectedUserId)).toBe(0);

  const rejectedResponse = await fetch(`${activeStack.baseUrl}/${rejectedUserId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Drop-Auth": POST_AUTH_CODE,
    },
    body: JSON.stringify(artifactBody),
  });

  expect(rejectedResponse.status).toBe(400);
  expect(await rejectedResponse.json()).toEqual({ error: "Invalid or missing userId" });
  expect(await countUserArtifactFiles(rejectedUserId)).toBe(0);
});
