import { resolve } from "node:path";

export interface DockerStackHandle {
  baseUrl: string;
  repoRoot: string;
  destroy(): Promise<void>;
}

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const RELAY_BASE_URL = "http://localhost:8080/drop/api";

export async function startDockerStack(): Promise<DockerStackHandle> {
  await Bun.$`vroom -s`.cwd(REPO_ROOT).quiet();
  await Bun.$`vroom -r`.cwd(REPO_ROOT).quiet();

  const deadline = Date.now() + 30_000;
  let lastError = "relay did not answer before timeout";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${RELAY_BASE_URL}/probe-user`);
      if (response.ok) {
        return {
          baseUrl: RELAY_BASE_URL,
          repoRoot: REPO_ROOT,
          async destroy(): Promise<void> {
            await Bun.$`vroom -d`.cwd(REPO_ROOT).quiet().nothrow();
          },
        };
      }

      lastError = `relay answered ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await Bun.sleep(250);
  }

  await Bun.$`vroom -d`.cwd(REPO_ROOT).quiet().nothrow();
  throw new Error(`Timed out waiting for local relay: ${lastError}`);
}
