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

      // The manifest is new, permanent, load-bearing state (I2's fix) — proving it's
      // written with exactly the installed names is what lets a later run tell "mine,
      // now stale" apart from "not mine, leave alone" (see T3 below).
      const targetEntries = await readdir(targetDir);
      expect(targetEntries.sort()).toEqual([".drop-f-skills.json", "alpha", "beta"]);

      const manifest = JSON.parse(await readFile(join(targetDir, ".drop-f-skills.json"), "utf8"));
      expect(manifest.sort()).toEqual(["alpha", "beta"]);
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

  it("removes a skill that vanished from source on a second run, but never touches an unrelated directory it never installed", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "drop-install-source-"));
    const targetDir = await mkdtemp(join(tmpdir(), "drop-install-target-"));

    try {
      await mkdir(join(sourceDir, "alpha"), { recursive: true });
      await writeFile(join(sourceDir, "alpha", "SKILL.md"), "# alpha v1\n", "utf8");
      await mkdir(join(sourceDir, "beta"), { recursive: true });
      await writeFile(join(sourceDir, "beta", "SKILL.md"), "# beta v1\n", "utf8");

      // Simulates another tool (e.g. ei) having already installed its own skill into
      // this shared discovery directory before drop-f ever ran here — installSkillsTo
      // must never know or care about it, since it was never recorded in its manifest.
      await mkdir(join(targetDir, "unrelated-tool-skill"), { recursive: true });
      await writeFile(join(targetDir, "unrelated-tool-skill", "SKILL.md"), "# not drop-f's\n", "utf8");

      await installSkillsTo(targetDir, sourceDir);

      // Fixture now matches a shipped-skill removal: beta no longer exists upstream.
      await rm(join(sourceDir, "beta"), { recursive: true, force: true });
      await installSkillsTo(targetDir, sourceDir);

      const targetEntries = await readdir(targetDir);
      expect(targetEntries.sort()).toEqual([".drop-f-skills.json", "alpha", "unrelated-tool-skill"]);
      expect(await readFile(join(targetDir, "unrelated-tool-skill", "SKILL.md"), "utf8")).toBe("# not drop-f's\n");
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });
});
