import { describe, expect, it } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startCaptureServer } from "../helpers/temp-server.ts";
import { TempRepo } from "../helpers/temp-repo.ts";

const CLI_PATH = fileURLToPath(new URL("../../../cli/push.ts", import.meta.url));
const REPO_SKILLS_DIR = fileURLToPath(new URL("../../../skills", import.meta.url));

interface PushRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runInstall(scratchHome: string, apiBase: string): Promise<PushRunResult> {
  const subprocess = Bun.spawn([process.execPath, "run", CLI_PATH, "--install"], {
    cwd: scratchHome,
    env: {
      ...process.env,
      HOME: scratchHome,
      // Points anywhere the code might accidentally fetch from if the --install
      // short-circuit in main() ever regressed to run after config/network setup —
      // a real relay domain wouldn't be reachable from a captured-requests assertion.
      DROP_API_BASE: apiBase,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("push.ts --install", () => {
  it("installs skills into every detected harness under a scratch HOME, skips undetected ones, and never touches the network", async () => {
    const scratchHome = await TempRepo.create("drop-push-install-");
    const captureServer = await startCaptureServer();

    try {
      // Only an OMP marker present — no OpenCode marker files. Claude Code is
      // unconditional and gets no marker at all.
      await scratchHome.write(".omp/agent/settings.json", "{}\n");

      const result = await runInstall(scratchHome.dir, captureServer.baseUrl);

      expect(result.exitCode).toBe(0);
      expect(captureServer.requests).toHaveLength(0);

      // Discovered at test-run time so this doesn't rot if a skill is renamed or added later.
      const skillEntries = await readdir(REPO_SKILLS_DIR, { withFileTypes: true });
      const skillNames = skillEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      expect(skillNames.length).toBeGreaterThan(0);

      for (const skillName of skillNames) {
        expect(await pathExists(join(scratchHome.dir, ".claude", "skills", skillName, "SKILL.md"))).toBe(true);
        expect(await pathExists(join(scratchHome.dir, ".omp", "agent", "skills", skillName, "SKILL.md"))).toBe(true);
      }

      // No OpenCode marker file existed, so its skills dir must never be created.
      expect(await pathExists(join(scratchHome.dir, ".config", "opencode", "skills"))).toBe(false);
    } finally {
      await captureServer.stop();
      await scratchHome.destroy();
    }
  });
});
