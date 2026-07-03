import { expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

interface RenderedConfig {
  renderedSource: string;
  constants: Record<string, string | null>;
}

interface RenderEnvironment {
  DB_HOSTNAME: string;
  DB_DATABASE: string;
  DB_USERNAME: string;
  DB_PASSWORD: string;
  DATA_PATH: string;
  DB_SOCKET?: string;
}

async function runCommand(args: string[]): Promise<string> {
  const subprocess = Bun.spawn(args, {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(subprocess.stdout).text();
  const stderr = await new Response(subprocess.stderr).text();
  const exitCode = await subprocess.exited;

  if (exitCode !== 0) {
    throw new Error(
      [
        `Command failed (${exitCode}): ${args.join(" ")}`,
        stdout.trim(),
        stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return stdout;
}

function dockerRunArgs(env: RenderEnvironment, ...command: string[]): string[] {
  const args = ["docker", "compose", "run", "--rm", "--no-deps"];

  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) {
      args.push("-e", `${name}=${value}`);
    }
  }

  args.push("api", ...command);
  return args;
}

async function renderConfig(env: RenderEnvironment): Promise<RenderedConfig> {
  const basename = `config.render-test.${crypto.randomUUID()}.php`;
  const hostOutputPath = join(REPO_ROOT, "api", basename);
  const containerOutputPath = `/app/api/${basename}`;

  try {
    await runCommand(
      dockerRunArgs(
        env,
        "php",
        "/app/scripts/render-config.php",
        "/app/api/config.php.template",
        containerOutputPath,
      ),
    );

    await runCommand(dockerRunArgs(env, "php", "-l", containerOutputPath));

    const constantsJson = await runCommand(
      dockerRunArgs(
        env,
        "php",
        "-r",
        [
          `require ${JSON.stringify(containerOutputPath)};`,
          "echo json_encode([",
          "  'DB_HOSTNAME' => defined('DB_HOSTNAME') ? DB_HOSTNAME : null,",
          "  'DB_DATABASE' => defined('DB_DATABASE') ? DB_DATABASE : null,",
          "  'DB_USERNAME' => defined('DB_USERNAME') ? DB_USERNAME : null,",
          "  'DB_PASSWORD' => defined('DB_PASSWORD') ? DB_PASSWORD : null,",
          "  'DATA_PATH' => defined('DATA_PATH') ? DATA_PATH : null,",
          "  'DB_SOCKET' => defined('DB_SOCKET') ? DB_SOCKET : null,",
          "]);",
        ].join(" "),
      ),
    );

    return {
      renderedSource: await readFile(hostOutputPath, "utf8"),
      constants: JSON.parse(constantsJson) as Record<string, string | null>,
    };
  } finally {
    await rm(hostOutputPath, { force: true });
  }
}

test("render-config preserves ugly secret bytes exactly and produces valid PHP via the Docker renderer", async () => {
  const env: RenderEnvironment = {
    DB_HOSTNAME: "db/primary&replica'\\\\host",
    DB_DATABASE: "drop/&prod'\\\\db",
    DB_USERNAME: "writer/&ops'\\\\user",
    DB_PASSWORD: "p@ss/word&'\\\\trail",
    DATA_PATH: "/tmp/drop/&path'\\\\share",
  };

  const { renderedSource, constants } = await renderConfig(env);

  expect(renderedSource).not.toContain("{{DB_HOSTNAME}}");
  expect(renderedSource).not.toContain("{{DATA_PATH}}");
  expect(constants).toEqual({
    DB_HOSTNAME: env.DB_HOSTNAME,
    DB_DATABASE: env.DB_DATABASE,
    DB_USERNAME: env.DB_USERNAME,
    DB_PASSWORD: env.DB_PASSWORD,
    DATA_PATH: env.DATA_PATH,
    DB_SOCKET: null,
  });
});
