import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export class TempRepo {
  readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
  }

  static async create(prefix = "drop-test-repo-"): Promise<TempRepo> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    const repo = new TempRepo(dir);
    await repo.git(["init"]);
    return repo;
  }

  async write(relativePath: string, contents: string): Promise<void> {
    const fullPath = join(this.dir, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

  async read(relativePath: string): Promise<string> {
    const fullPath = join(this.dir, relativePath);
    return readFile(fullPath, "utf8");
  }

  async git(args: string[]): Promise<string> {
    const subprocess = Bun.spawn(["git", ...args], {
      cwd: this.dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(subprocess.stdout).text();
    const stderr = await new Response(subprocess.stderr).text();
    const exitCode = await subprocess.exited;

    if (exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
    }

    return stdout.trim();
  }

  async indexHash(): Promise<string> {
    const indexFile = Bun.file(join(this.dir, ".git", "index"));
    if (!(await indexFile.exists())) {
      return "";
    }

    const hasher = new Bun.CryptoHasher("sha1");
    hasher.update(await indexFile.arrayBuffer());
    return hasher.digest("hex");
  }

  async destroy(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
