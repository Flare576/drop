#!/usr/bin/env bun
/**
 * push.ts — encrypts a git working-tree diff and pushes it to the drop relay.
 *
 * Harness-agnostic: this file has zero knowledge of which coding harness (OhMyPi,
 * Claude Code, or a bare terminal) invoked it. It only cares about the git repo it
 * runs in and the four DROP_* config values. A coding agent invokes this directly —
 * see skills/drop-diff/SKILL.md — when it decides a push is warranted, or when the
 * user asks; there is no automatic trigger. See cli/README.md and
 * docs/adr/0003-skills-over-hooks.md.
 *
 * Usage:
 *   bun run cli/push.ts [--filename <name>] [--username <u>] [--passphrase <p>]
 *                        [--drop-auth <code>] [--api-base <url>] [--input <path>]
 *   bun run cli/push.ts --install
 *
 * By default, pushes a git working-tree diff. Pass --input <path> to push the raw
 * bytes of a file instead (any content, not just a diff — pushed as-is, even if
 * empty). Pass --install to copy this package's skills/ into detected coding-harness
 * skill directories and exit; no network, git, or crypto is touched in that mode.
 *
 * Config precedence (highest wins): CLI flags > environment variables > config file
 * at ~/.doNotCommit.d/.doNotCommit.droprelay (KEY=value or `export KEY=value` lines,
 * matching this user's existing untracked-secrets convention).
 */

import { homedir } from "node:os";
import { join, basename } from "node:path";
import { generateUserId, encrypt, type CryptoCredentials } from "../shared/crypto.ts";
import { runInstall } from "./install.ts";

const CONFIG_FILE = join(homedir(), ".doNotCommit.d", ".doNotCommit.droprelay");
const DEFAULT_API_BASE = "https://flare576.com/drop/api";

// ---------------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------------

interface CliFlags {
  filename?: string;
  username?: string;
  passphrase?: string;
  dropAuth?: string;
  apiBase?: string;
  input?: string;
  install?: boolean;
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {};
  const table: Record<string, Exclude<keyof CliFlags, "install">> = {
    "--filename": "filename",
    "--username": "username",
    "--passphrase": "passphrase",
    "--drop-auth": "dropAuth",
    "--api-base": "apiBase",
    "--input": "input",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    // Checked before the value-consuming table below so a literal "--install"
    // that arrived as ANOTHER flag's value (e.g. `--input --install`, pushing a
    // file actually named "--install") is never re-interpreted as this flag —
    // that token is already consumed by the table branch's `argv[++i]` before
    // the loop ever reaches a fresh iteration on it.
    if (arg === "--install") {
      flags.install = true;
      continue;
    }

    const eq = arg.indexOf("=");
    const [flag, inlineValue] = eq !== -1 && arg.startsWith("--") ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];

    const key = table[flag];
    if (!key) continue;

    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
    } else {
      const value = argv[++i];
      if (value === undefined) {
        console.error(`Missing value for ${flag}`);
        process.exit(1);
      }
      flags[key] = value;
    }
  }

  return flags;
}

// ---------------------------------------------------------------------------------
// Config file (~/.doNotCommit.d/.doNotCommit.droprelay)
// ---------------------------------------------------------------------------------

/** Parses simple `KEY=value` lines, tolerating `export KEY=value`, comments, and quoted values. */
async function readConfigFile(path: string): Promise<Record<string, string>> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};

  const values: Record<string, string> = {};
  const text = await file.text();

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice("export ".length) : line;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;

    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();

    // Strip matching surrounding quotes, and drop trailing inline comments on
    // unquoted values (mirrors typical shell-sourced env file conventions).
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hashIdx = value.indexOf(" #");
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    }

    values[key] = value;
  }

  return values;
}

interface ResolvedConfig {
  username?: string;
  passphrase?: string;
  dropAuth?: string;
  apiBase: string;
}

async function resolveConfig(flags: CliFlags): Promise<ResolvedConfig> {
  const fileValues = await readConfigFile(CONFIG_FILE);

  const pick = (flagValue: string | undefined, envKey: string): string | undefined =>
    flagValue ?? process.env[envKey] ?? fileValues[envKey];

  return {
    username: pick(flags.username, "DROP_USERNAME"),
    passphrase: pick(flags.passphrase, "DROP_PASSPHRASE"),
    dropAuth: pick(flags.dropAuth, "DROP_AUTH"),
    apiBase: pick(flags.apiBase, "DROP_API_BASE") ?? DEFAULT_API_BASE,
  };
}

/** Fails loudly, naming exactly which values are missing. No partial attempt. */
function requireCredentials(config: ResolvedConfig): CryptoCredentials & { dropAuth: string } {
  const missing: string[] = [];
  if (!config.username) missing.push("DROP_USERNAME (--username)");
  if (!config.passphrase) missing.push("DROP_PASSPHRASE (--passphrase)");
  if (!config.dropAuth) missing.push("DROP_AUTH (--drop-auth)");

  if (missing.length > 0) {
    console.error("push.ts: missing required configuration:");
    for (const m of missing) console.error(`  - ${m}`);
    console.error(`Resolve via CLI flag, environment variable, or ${CONFIG_FILE}`);
    process.exit(1);
  }

  return { username: config.username!, passphrase: config.passphrase!, dropAuth: config.dropAuth! };
}

// ---------------------------------------------------------------------------------
// Git diff capture
// ---------------------------------------------------------------------------------

/**
 * Captures a full working-tree diff (staged + unstaged + untracked, binary-safe)
 * against HEAD, without mutating the repo's real index or working tree.
 *
 * The task's reference sequence — `git add -A -N` (intent-to-add), `git diff HEAD
 * --binary`, `git reset` — was verified against a repo that already had staged
 * changes: `git reset` with no arguments unstages *everything*, including changes
 * that were staged before this script ran, which breaks "leave the index untouched".
 * Instead, this copies the real index to a scratch file, points GIT_INDEX_FILE at
 * the copy for the add+diff steps, and discards the copy — the real .git/index is
 * never opened for writing. Verified byte-identical via `shasum .git/index`
 * before/after against a repo with staged+unstaged+untracked changes simultaneously.
 *
 * A freshly initialized repo (no commits yet) has no HEAD, so `git diff HEAD` fails
 * with exit 128 ("ambiguous argument 'HEAD'") before ever reading the working tree —
 * this is the exact moment someone is most likely to use the tool for the first time
 * (Beta QA finding I6). Detected via `git rev-parse --verify HEAD` and, when absent,
 * diffed against `4b825dc642cb6eb9a060e54bf8d69288fbee4904` — git's well-known SHA-1
 * hash of the empty tree, valid in every git repo without needing a real commit to
 * exist, giving the same "everything is new" diff a first commit would produce.
 */
async function captureDiff(repoRoot: string): Promise<string> {
  const realIndexPath = (await Bun.$`git rev-parse --git-path index`.cwd(repoRoot).quiet().text()).trim();
  const scratchIndexPath = join(repoRoot, `.git`, `push-ts-scratch-index-${process.pid}-${Date.now()}`);

  const realIndexFile = Bun.file(join(repoRoot, realIndexPath));
  if (await realIndexFile.exists()) {
    await Bun.write(scratchIndexPath, realIndexFile);
  }
  // If there's no index yet (brand new repo, nothing ever added), omit the copy —
  // git treats a missing GIT_INDEX_FILE as an empty index, which is correct here.

  const env = { ...process.env, GIT_INDEX_FILE: scratchIndexPath };

  try {
    const hasHead = (await Bun.$`git rev-parse --verify -q HEAD`.cwd(repoRoot).env(env).quiet().nothrow())
      .exitCode === 0;
    const diffTarget = hasHead ? "HEAD" : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

    await Bun.$`git add -A -N .`.cwd(repoRoot).env(env).quiet();
    const diff = await Bun.$`git diff ${diffTarget} --binary -M`.cwd(repoRoot).env(env).quiet().text();
    return diff;
  } finally {
    await Bun.$`rm -f ${scratchIndexPath}`.quiet().nothrow();
  }
}

// ---------------------------------------------------------------------------------
// Retry-After / human time formatting
// ---------------------------------------------------------------------------------

function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return `${totalSeconds} seconds`;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} second${seconds === 1 ? "" : "s"}`);

  return parts.join(", ");
}

// ---------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.install) {
    const succeeded = await runInstall();
    process.exit(succeeded ? 0 : 1);
  }

  const config = await resolveConfig(flags);
  const credentials = requireCredentials(config);

  let content: Uint8Array;
  let defaultFilename: string;

  if (flags.input) {
    // Explicit user intent: push exactly what's in the file, regardless of size —
    // unlike diff mode, there is no "nothing to push" ambiguity to short-circuit on.
    const inputFile = Bun.file(flags.input);
    if (!(await inputFile.exists())) {
      console.error(`push.ts: --input file not found: ${flags.input}`);
      process.exit(1);
    }
    content = new Uint8Array(await inputFile.arrayBuffer());
    defaultFilename = basename(flags.input);
  } else {
    // Confirm we're in a git repo and get its top-level dir + basename for the
    // default filename, before touching the index at all.
    let repoRoot: string;
    try {
      repoRoot = (await Bun.$`git rev-parse --show-toplevel`.quiet().text()).trim();
    } catch {
      console.error("push.ts: not inside a git repository (git rev-parse --show-toplevel failed)");
      process.exit(1);
    }

    let patch: string;
    try {
      patch = await captureDiff(repoRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`push.ts: failed to compute git diff: ${message}`);
      process.exit(1);
    }

    if (patch.trim() === "") {
      console.log("Nothing to push (no working tree changes)");
      process.exit(0);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    defaultFilename = `${basename(repoRoot)}-${timestamp}.patch`;
    content = new TextEncoder().encode(patch);
  }

  const filename = flags.filename ?? defaultFilename;

  // Envelope: JSON header (filename) + NUL delimiter + raw content, all as one
  // Uint8Array — see shared/crypto.ts for why this lives here, not in crypto.ts.
  const header = new TextEncoder().encode(JSON.stringify({ filename }) + "\0");
  const plaintext = Buffer.concat([header, content]);

  let userId: string;
  let encrypted: { iv: string; ciphertext: string };
  try {
    userId = await generateUserId(credentials);
    encrypted = await encrypt(plaintext, credentials);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`push.ts: encryption failed: ${message}`);
    process.exit(1);
  }

  const url = `${config.apiBase.replace(/\/+$/, "")}/${userId}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Drop-Auth": credentials.dropAuth,
      },
      body: JSON.stringify(encrypted),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`push.ts: request to ${config.apiBase} failed (network error): ${message}`);
    process.exit(1);
  }

  if (response.status === 201) {
    const body = (await response.json()) as { artifactId: string; expiresAt: string };
    console.log("Push succeeded:");
    console.log(`  artifactId: ${body.artifactId}`);
    console.log(`  expiresAt:  ${body.expiresAt}`);
    process.exit(0);
  }

  if (response.status === 403) {
    console.error("push.ts: push rejected (403 Forbidden) — DROP_AUTH does not match a code the relay currently recognizes.");
    console.error(`Check the value in ${CONFIG_FILE} or the DROP_AUTH environment variable.`);
    process.exit(1);
  }

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("Retry-After");

    let bodyRetryAfter: number | undefined;
    try {
      const body = (await response.json()) as { retry_after?: number };
      bodyRetryAfter = body.retry_after;
    } catch {
      bodyRetryAfter = undefined;
    }

    const retryAfterSeconds = bodyRetryAfter ?? (retryAfterHeader ? Number(retryAfterHeader) : undefined);

    console.error(
      retryAfterSeconds !== undefined
        ? `push.ts: rate-limited by the relay. Try again in ${formatDuration(retryAfterSeconds)}.`
        : "push.ts: rate-limited by the relay. Try again shortly.",
    );
    process.exit(1);
  }

  if (response.status === 400) {
    console.error("push.ts: relay rejected the request body as malformed (400) — this indicates a bug in push.ts's envelope construction, not a config issue.");
    process.exit(1);
  }

  console.error(`push.ts: push failed with unexpected status ${response.status} ${response.statusText}`);
  process.exit(1);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`push.ts: unexpected error: ${message}`);
  process.exit(1);
});
