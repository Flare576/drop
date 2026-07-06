import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installSkillsTo } from "../../../cli/install.ts";

describe("installSkillsTo", () => {
  it("copies each skill subdirectory into targetDir and skips a stray non-directory file at the source root", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "drop-install-source-"));
    const targetDir = await mkdtemp(join(tmpdir(), "drop-install-target-"));

    try {
      await mkdir(join(sourceDir, "alpha"), { recursive: true });
      await writeFile(join(sourceDir, "alpha", "SKILL.md"), "# alpha v1\n", "utf8");
      await mkdir(join(sourceDir, "beta"), { recursive: true });
      await writeFile(join(sourceDir, "beta", "SKILL.md"), "# beta v1\n", "utf8");
      // Stray file directly under the skills root — must not be treated as a skill.
      await writeFile(join(sourceDir, "README.md"), "not a skill\n", "utf8");

      await installSkillsTo(targetDir, sourceDir);

      expect(await readFile(join(targetDir, "alpha", "SKILL.md"), "utf8")).toBe("# alpha v1\n");
      expect(await readFile(join(targetDir, "beta", "SKILL.md"), "utf8")).toBe("# beta v1\n");

      const targetEntries = await readdir(targetDir);
      expect(targetEntries.sort()).toEqual(["alpha", "beta"]);
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it("overwrites a previously installed skill's contents on a second call instead of merging stale files", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "drop-install-source-"));
    const targetDir = await mkdtemp(join(tmpdir(), "drop-install-target-"));

    try {
      await mkdir(join(sourceDir, "alpha"), { recursive: true });
      await writeFile(join(sourceDir, "alpha", "SKILL.md"), "# alpha v1\n", "utf8");
      await writeFile(join(sourceDir, "alpha", "old-file.md"), "stale\n", "utf8");
      await installSkillsTo(targetDir, sourceDir);

      // Modify the fixture as if the shipped skill changed: SKILL.md content changes,
      // old-file.md is removed entirely.
      await rm(join(sourceDir, "alpha", "old-file.md"));
      await writeFile(join(sourceDir, "alpha", "SKILL.md"), "# alpha v2\n", "utf8");
      await installSkillsTo(targetDir, sourceDir);

      expect(await readFile(join(targetDir, "alpha", "SKILL.md"), "utf8")).toBe("# alpha v2\n");
      const alphaEntries = await readdir(join(targetDir, "alpha"));
      expect(alphaEntries).toEqual(["SKILL.md"]);
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it("does nothing when sourceDir does not exist, leaving targetDir untouched", async () => {
    const targetDir = await mkdtemp(join(tmpdir(), "drop-install-target-"));

    try {
      await installSkillsTo(targetDir, join(targetDir, "does-not-exist"));

      const entries = await readdir(targetDir);
      expect(entries).toHaveLength(0);
    } finally {
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it("never removes a skill that vanished from source, and never touches an unrelated directory it never installed", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "drop-install-source-"));
    const targetDir = await mkdtemp(join(tmpdir(), "drop-install-target-"));

    try {
      await mkdir(join(sourceDir, "alpha"), { recursive: true });
      await writeFile(join(sourceDir, "alpha", "SKILL.md"), "# alpha v1\n", "utf8");
      await mkdir(join(sourceDir, "beta"), { recursive: true });
      await writeFile(join(sourceDir, "beta", "SKILL.md"), "# beta v1\n", "utf8");

      // Simulates another tool (e.g. ei) having already installed its own skill into
      // this shared discovery directory before drop-f ever ran here — installSkillsTo
      // must never know or care about it; removal is driven solely by the static
      // DEPRECATED_SKILL_NAMES list, never by scanning targetDir's existing contents.
      await mkdir(join(targetDir, "unrelated-tool-skill"), { recursive: true });
      await writeFile(join(targetDir, "unrelated-tool-skill", "SKILL.md"), "# not drop-f's\n", "utf8");

      await installSkillsTo(targetDir, sourceDir);

      // beta disappears upstream between the two runs — this must NOT translate into
      // a removal from targetDir. The old dynamic diff-and-remove mechanism reacted
      // to exactly this and had two real bugs as a result (an unvalidated manifest
      // entry enabling path traversal, and a transient read failure misread as "the
      // skill was removed"); the fix decouples removal entirely from source contents.
      await rm(join(sourceDir, "beta"), { recursive: true, force: true });
      await writeFile(join(sourceDir, "alpha", "SKILL.md"), "# alpha v2\n", "utf8");
      await installSkillsTo(targetDir, sourceDir);

      const targetEntries = await readdir(targetDir);
      expect(targetEntries.sort()).toEqual(["alpha", "beta", "unrelated-tool-skill"]);
      // alpha is still correctly re-copied on every run — proves the second call did
      // real work, it just never deletes anything based on a source-content diff.
      expect(await readFile(join(targetDir, "alpha", "SKILL.md"), "utf8")).toBe("# alpha v2\n");
      // beta's OLD content survives untouched: no longer in source, so this run
      // correctly neither removes it nor re-copies it — it's simply left alone.
      expect(await readFile(join(targetDir, "beta", "SKILL.md"), "utf8")).toBe("# beta v1\n");
      expect(await readFile(join(targetDir, "unrelated-tool-skill", "SKILL.md"), "utf8")).toBe("# not drop-f's\n");
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it("never removes anything from targetDir when DEPRECATED_SKILL_NAMES is empty (the list currently shipped)", async () => {
    // DEPRECATED_SKILL_NAMES is a static, developer-committed constant inside
    // install.ts, and it's currently empty — nothing has ever been retired. This
    // test can't append to it without editing the protected implementation file,
    // so instead it pins down the CURRENT observable contract: with an empty list,
    // installSkillsTo must never delete pre-existing targetDir contents, no matter
    // what they're named.
    const sourceDir = await mkdtemp(join(tmpdir(), "drop-install-source-"));
    const targetDir = await mkdtemp(join(tmpdir(), "drop-install-target-"));

    try {
      await mkdir(join(sourceDir, "alpha"), { recursive: true });
      await writeFile(join(sourceDir, "alpha", "SKILL.md"), "# alpha v1\n", "utf8");

      // Uses the exact example name from DEPRECATED_SKILL_NAMES's own doc comment
      // ("old-skill-name") to prove that even a name that looks like a plausible
      // future deprecation entry survives untouched while the real list is empty.
      await mkdir(join(targetDir, "old-skill-name"), { recursive: true });
      await writeFile(join(targetDir, "old-skill-name", "SKILL.md"), "# stale\n", "utf8");

      await installSkillsTo(targetDir, sourceDir);

      expect(await readFile(join(targetDir, "old-skill-name", "SKILL.md"), "utf8")).toBe("# stale\n");
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it("never deletes a previously-installed skill when sourceDir becomes unreadable on a later run", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "drop-install-source-"));
    const targetDir = await mkdtemp(join(tmpdir(), "drop-install-target-"));

    try {
      await mkdir(join(sourceDir, "alpha"), { recursive: true });
      await writeFile(join(sourceDir, "alpha", "SKILL.md"), "# alpha v1\n", "utf8");
      await installSkillsTo(targetDir, sourceDir);
      expect(await readFile(join(targetDir, "alpha", "SKILL.md"), "utf8")).toBe("# alpha v1\n");

      // Simulate the source becoming unreadable (a bunx cache eviction mid-run, a
      // permissions change, a half-finished upgrade) rather than intentionally
      // missing. This is the direct regression test for the old manifest mechanism
      // reading a source failure as "the skill was removed" and deleting an install
      // that never actually failed. The fix makes source-read failure and deletion
      // entirely independent code paths — a failure here can only mean "installed
      // nothing this run", never "delete what's already there".
      await rm(sourceDir, { recursive: true, force: true });

      await installSkillsTo(targetDir, sourceDir);

      expect(await readFile(join(targetDir, "alpha", "SKILL.md"), "utf8")).toBe("# alpha v1\n");
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  // No dedicated test exercises DEPRECATED_SKILL_NAMES's basename() sanitization
  // directly: the real shipped list is empty, and populating it to prove the
  // sanitization fires would mean editing the protected constant in install.ts.
  // That's fine — the sanitization is now defense-in-depth around static,
  // compile-time string literals reviewed in the same commit that adds them, not
  // a runtime-controlled path. There is no remaining code path (manifest, source
  // diff, or otherwise) that ever feeds dynamic or attacker-influenced input into
  // the removal loop, which is precisely the property that made the old
  // mechanism's path traversal possible.
});
