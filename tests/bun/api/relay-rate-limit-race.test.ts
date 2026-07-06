import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { startDockerStack, type DockerStackHandle } from "../helpers/docker-stack";

const POST_AUTH_CODE = "dev-local-only";
// Matches api/config.php.template's RATE_LIMIT_MAX. If that constant changes, this
// must change too -- there's no shared source of truth between PHP and this test.
const RATE_LIMIT_MAX = 30;
const CONCURRENT_REQUESTS = 40;

let stack: DockerStackHandle | undefined;

setDefaultTimeout(90_000);

beforeAll(async () => {
  stack = await startDockerStack();
});

afterAll(async () => {
  if (stack) {
    await stack.destroy();
  }
});

test("admits exactly RATE_LIMIT_MAX concurrent POSTs for one userId, never more", async () => {
  const userId = crypto.randomUUID().replaceAll("-", "");
  const activeStack = stack;
  if (!activeStack) {
    throw new Error("Docker stack was not started");
  }

  // Fire all requests essentially simultaneously -- this is the exact shape of the bug:
  // checkRateLimit() (read) and recordRateLimitRequest() (write) as two separate,
  // unlocked statements let two concurrent requests both read the same pre-burst
  // window and both be admitted, silently dropping one request's accounting. With a
  // single-worker PHP server, none of the requests would ever truly overlap and this
  // test would pass even against the buggy code -- see docker-compose.yml's
  // PHP_CLI_SERVER_WORKERS for why that's not the case here.
  const responses = await Promise.all(
    Array.from({ length: CONCURRENT_REQUESTS }, () =>
      fetch(`${activeStack.baseUrl}/${userId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Drop-Auth": POST_AUTH_CODE,
        },
        body: JSON.stringify({ iv: "AAAA", ciphertext: "AAAA" }),
      }),
    ),
  );

  const statusCounts = responses.reduce<Record<number, number>>((counts, res) => {
    counts[res.status] = (counts[res.status] ?? 0) + 1;
    return counts;
  }, {});

  expect(statusCounts[201] ?? 0).toBe(RATE_LIMIT_MAX);
  expect(statusCounts[429] ?? 0).toBe(CONCURRENT_REQUESTS - RATE_LIMIT_MAX);

  // The persisted window itself must also reflect exactly RATE_LIMIT_MAX entries --
  // the race's real failure mode was a corrupted/undercounted stored window, which
  // would let a later, non-concurrent request slip through even after the burst.
  const listResponse = await fetch(`${activeStack.baseUrl}/${userId}`);
  const listBody = (await listResponse.json()) as { items: unknown[] };
  expect(listBody.items).toHaveLength(RATE_LIMIT_MAX);

  const followUpResponse = await fetch(`${activeStack.baseUrl}/${userId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Drop-Auth": POST_AUTH_CODE,
    },
    body: JSON.stringify({ iv: "AAAA", ciphertext: "AAAA" }),
  });
  expect(followUpResponse.status).toBe(429);
});
