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
});
