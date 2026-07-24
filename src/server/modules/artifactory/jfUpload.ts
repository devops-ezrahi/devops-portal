import { execFile } from "child_process";
import { promisify } from "util";
import { config } from "../../config";

const execFileAsync = promisify(execFile);

export async function jfUpload(
  src: string,
  target: string,
  extraArgs: string[] = [],
  onLog: (line: string) => void = () => {}
): Promise<void> {
  const { url, token } = config.artifactory;
  if (!url || !token) {
    throw new Error("ARTIFACTORY_URL and ARTIFACTORY_TOKEN must be set to use jf CLI");
  }

  const displayArgs = ["rt", "u", src, target, ...extraArgs];
  onLog(`$ jf ${displayArgs.join(" ")}`);

  const cliArgs = [...displayArgs, "--url", url, "--access-token", token];

  try {
    const { stdout, stderr } = await execFileAsync("jf", cliArgs, {
      maxBuffer: 10 * 1024 * 1024,
    });
    const lines = `${stdout}\n${stderr}`.split("\n").filter(Boolean);
    for (const line of lines) onLog(line);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (e.code === "ENOENT") {
      throw new Error("jf CLI not found — install JFrog CLI and ensure it is on PATH");
    }
    const detail = [e.stderr, e.stdout, e.message].find(Boolean) ?? "jf CLI command failed";
    throw new Error(detail.toString().trim());
  }
}
