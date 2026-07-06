import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";

/**
 * Filename (not a skill name — never matches a real skill directory) recording
 * which skill names THIS package installed into a given targetDir on a prior
 * run. Shared skill-discovery directories (`~/.claude/skills/`, etc.) can hold
 * other tools' skills too (e.g. `ei` installs into these exact same paths) —
 * without this manifest, cleaning up a skill drop-f itself removed from a
 * later version would have no safe way to distinguish "mine, now stale" from
 * "not mine, leave alone." Only names ever recorded here by this function are
 * ever candidates for removal.
 */
const MANIFEST_FILENAME = ".drop-f-skills.json";

/**
 * Copy every skills/<name>/ directory from drop-f's own package into a
 * harness's native skill-discovery directory (targetDir). Copy, not
 * symlink — a symlink into an npm/bunx-installed package's cache breaks
 * silently on upgrade/uninstall, and Windows symlinks need elevated
 * permissions. Generic over whatever exists under skills/ — adding a new
 * drop-f-shipped skill later requires zero changes here. Overwrites
 * unconditionally on every run, and removes any skill THIS function
 * previously installed into targetDir that source no longer has (tracked via
 * `MANIFEST_FILENAME`, never by diffing targetDir's full contents — see above).
 *
 * `sourceDir` defaults to drop-f's own packaged skills/ (resolved relative
 * to this file's own location, so it works regardless of install method —
 * global npm, bunx, or a from-source checkout, since cli/ and skills/ ship
 * together per package.json's "files" field) and exists as a parameter
 * purely so tests can redirect it at a fixture directory instead.
 */
export async function installSkillsTo(targetDir: string, sourceDir?: string): Promise<void> {
  // `.pathname` on a file:// URL keeps a leading slash before a Windows
  // drive letter (`/C:/Users/...`), which fs APIs on Windows do not accept
  // as an absolute path — fileURLToPath() normalizes it correctly on every OS.
  const skillsSourceDir = sourceDir ?? fileURLToPath(new URL("../skills", import.meta.url));

  // Plain fs.stat instead of shelling out to `test -d` — `test` is not a
  // Bun Shell builtin (it falls back to a PATH lookup), and stock Windows
  // ships no `test` binary, so a shell-based check would silently treat
  // every Windows install as "source doesn't exist" and skip skill
  // installation with no warning at all.
  let skillNames: string[] = [];
  try {
    const sourceStat = await stat(skillsSourceDir);
    if (sourceStat.isDirectory()) {
      // fs.readdir + isDirectory() instead of `ls -d dir/*/` — skips stray
      // files directly under skills/ (e.g. a top-level README.md) without
      // depending on Bun Shell's undocumented `-d` flag support or POSIX
      // glob semantics.
      const entries = await readdir(skillsSourceDir, { withFileTypes: true });
      skillNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    }
  } catch {
    // From-source checkout or a package build that predates this feature —
    // no skills to install, but still fall through to reconcile any stale
    // manifest entries below (source having vanished entirely is the same
    // "no longer present" signal as one skill within it disappearing).
  }

  const manifestPath = join(targetDir, MANIFEST_FILENAME);
  let previouslyInstalled: string[] = [];
  try {
    previouslyInstalled = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    // No manifest yet — first run against this targetDir, or a targetDir
    // that predates this manifest mechanism. Nothing to reconcile against.
  }

  for (const staleName of previouslyInstalled) {
    if (!skillNames.includes(staleName)) {
      await rm(join(targetDir, staleName), { recursive: true, force: true });
    }
  }

  if (skillNames.length === 0) {
    if (previouslyInstalled.length > 0) {
      // Record the now-empty set so a later run (source restored) reconciles
      // correctly instead of comparing against stale prior names forever.
      await mkdir(targetDir, { recursive: true });
      await writeFile(manifestPath, JSON.stringify([]));
    }
    return;
  }

  await mkdir(targetDir, { recursive: true });

  for (const skillName of skillNames) {
    const dest = join(targetDir, skillName);
    // fs.cp merges into an existing dest rather than nesting like a naive
    // `cp -r` would, but it won't remove files that only exist in a stale
    // prior copy — clear first so every run leaves an exact mirror of the
    // current source.
    await rm(dest, { recursive: true, force: true });
    await cp(join(skillsSourceDir, skillName), dest, { recursive: true });
  }

  await writeFile(manifestPath, JSON.stringify(skillNames));

  console.log(`✓ Installed ${skillNames.length} skill(s) to ${targetDir}`);
}

function resolveHome(): string {
  // Plain Windows shells (cmd.exe, PowerShell without Git Bash/WSL) don't set
  // $HOME — os.homedir() reads USERPROFILE there instead. Without this
  // fallback, `home` silently became the literal string "~", and every
  // downstream join("~", ...) resolved relative to CWD instead of the user's
  // actual profile directory.
  return process.env.HOME || homedir();
}

/** Returns true on success, false if `step` threw — caller decides what a
 *  failure means for its own overall exit status. */
async function runInstallStep(label: string, step: () => Promise<void>): Promise<boolean> {
  try {
    await step();
    return true;
  } catch (e) {
    console.warn(`⚠️  ${label} install step failed: ${e instanceof Error ? e.message : String(e)}`);
    console.warn(`   Skipping — other integrations will still be attempted.`);
    return false;
  }
}

/**
 * Detects which coding harnesses are present on this machine and copies
 * drop-f's skills/ into each one's native skill directory. Scoped WAY down
 * from ei's own installMcpClients: drop-f has no MCP servers, hooks, or
 * extension files to register — this is skill-file copying only, for the
 * three harnesses that have a native skill-markdown discovery convention.
 */
export async function runInstall(): Promise<boolean> {
  const home = resolveHome();
  let allAttemptedSucceeded = true;

  // Claude Code: unconditional attempt, no detection gate — ~/.claude/skills/
  // is harmless to create even if Claude Code isn't actually installed.
  if (!(await runInstallStep("Claude Code", () => installSkillsTo(join(home, ".claude", "skills"))))) {
    allAttemptedSucceeded = false;
  }

  const ompAgentDir = join(home, ".omp", "agent");
  const hasOmp =
    (await Bun.file(join(ompAgentDir, "settings.json")).exists()) ||
    (await Bun.file(join(ompAgentDir, "auth.json")).exists()) ||
    (await Bun.file(join(ompAgentDir, "config.yml")).exists()) ||
    (await Bun.file(join(ompAgentDir, "agent.db")).exists());

  if (hasOmp) {
    if (!(await runInstallStep("OMP", () => installSkillsTo(join(ompAgentDir, "skills"))))) {
      allAttemptedSucceeded = false;
    }
  } else {
    console.log(`ℹ️  OMP not detected — skipping.`);
  }

  const opencodeDir = join(home, ".config", "opencode");
  const hasOpenCode =
    (await Bun.file(join(opencodeDir, "opencode.jsonc")).exists()) ||
    (await Bun.file(join(opencodeDir, "opencode.json")).exists()) ||
    (await Bun.file(join(opencodeDir, "opencode.db")).exists());

  if (hasOpenCode) {
    if (!(await runInstallStep("OpenCode", () => installSkillsTo(join(opencodeDir, "skills"))))) {
      allAttemptedSucceeded = false;
    }
  } else {
    console.log(`ℹ️  OpenCode not detected — skipping.`);
  }

  return allAttemptedSucceeded;
}
