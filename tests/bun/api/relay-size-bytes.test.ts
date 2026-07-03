import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { startDockerStack, type DockerStackHandle } from "../helpers/docker-stack";

const POST_AUTH_CODE = "dev-local-only";

let stack: DockerStackHandle | undefined;

function makeUserId(length = 48): string {
  const seed = crypto.randomUUID().replaceAll("-", "");
  return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
}

setDefaultTimeout(30_000);

beforeAll(async () => {
  stack = await startDockerStack();
});

afterAll(async () => {
  if (stack) {
    await stack.destroy();
  }
});

test("reports sizeBytes as decoded ciphertext bytes, not base64 text length", async () => {
  const userId = makeUserId();
  const ciphertext = "aGVsbG8=";
  const expectedBytes = Buffer.from(ciphertext, "base64").length;
  const activeStack = stack;
  if (!activeStack) {
    throw new Error("Docker stack was not started");
  }

  const postResponse = await fetch(`${activeStack.baseUrl}/${userId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Drop-Auth": POST_AUTH_CODE,
    },
    body: JSON.stringify({
      iv: "AA==",
      ciphertext,
    }),
  });

  expect(postResponse.status).toBe(201);

  const listResponse = await fetch(`${activeStack.baseUrl}/${userId}`);
  expect(listResponse.status).toBe(200);
  const listBody = (await listResponse.json()) as {
    items: Array<{ sizeBytes: number }>;
  };

  expect(listBody.items).toHaveLength(1);
  expect(listBody.items[0]?.sizeBytes).toBe(expectedBytes);
});
