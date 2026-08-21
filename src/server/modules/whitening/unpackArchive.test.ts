import { execFile } from "child_process";
import { mkdtempSync } from "fs";
import { mkdir, mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { describe, expect, it, vi } from "vitest";
import type { PortalUser } from "../../types";

vi.mock("../../config", () => ({
  config: {
    // Fresh per run: the job store persists, so a shared dir would carry ids
    // and history over from the last `npm test`.
    dataDir: mkdtempSync(join(tmpdir(), "whitening-test-")),
    artifactory: { url: "", repo: "", npmRepo: "", token: "", dockerRepo: "" },
    git: { url: "https://bitbucket.example.com", token: "git-token", username: "" },
    // redactSecrets reads all three token/key sources, so all three must exist.
    ai: { apiKey: "" },
  },
}));

// submitUnpack only extracts and reads config.json; the PR work happens later
// in run(), which never starts here because the job stays pending until polled.
vi.mock("./BitbucketApi", () => ({
  BitbucketApi: class {
    async openPullRequest() {
      return { url: "", id: 0 };
    }
  },
}));

const execFileAsync = promisify(execFile);
const { RealWhiteningApi } = await import("./RealWhiteningApi");

const user: PortalUser = { id: "dana", displayName: "Dana Levi", email: "d@e.com", groups: [] };

const packConfig = {
  version: "1.2.3",
  repos: {
    portal: { department: "platform", team: "DEVOPS", repository: "devops-portal" },
  },
};

/**
 * Build a pack tree on disk, then archive it in the requested format.
 *
 * ponytail: shells out to whatever can make a zip on this platform — `zip` on
 * Linux/CI, PowerShell's Compress-Archive on Windows, where Git Bash ships
 * unzip but not zip. Swap in a zip library only if a third platform shows up.
 */
async function buildArchive(format: "tgz" | "zip"): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), `pack-${format}-`));
  await mkdir(join(dir, "repository", "devops-portal"), { recursive: true });
  await writeFile(join(dir, "repository", "config.json"), JSON.stringify(packConfig));

  const archive = join(dir, `pack.${format}`);
  if (format !== "zip") {
    await execFileAsync("tar", ["-czf", `pack.${format}`, "repository"], { cwd: dir });
  } else if (process.platform === "win32") {
    await execFileAsync("powershell", [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path 'repository' -DestinationPath '${archive}'`,
    ], { cwd: dir });
  } else {
    await execFileAsync("zip", ["-qr", archive, "repository"], { cwd: dir });
  }
  return readFile(archive);
}

describe("submitUnpack archive formats", () => {
  it("accepts a .tgz pack", async () => {
    const api = new RealWhiteningApi();
    const job = await api.submitUnpack(await buildArchive("tgz"), "pack.tgz", user);

    expect(job.team).toBe("DEVOPS");
    expect(job.version).toBe("1.2.3");
  });

  // Debian's GNU tar cannot read zip, so this goes through unzip instead — the
  // reason the runtime image has to install it (see Dockerfile).
  it("accepts a .zip pack, reading the same repository/config.json", async () => {
    const api = new RealWhiteningApi();
    const job = await api.submitUnpack(await buildArchive("zip"), "pack.zip", user);

    expect(job.team).toBe("DEVOPS");
    expect(job.version).toBe("1.2.3");
  });

  it("rejects an archive that is neither", async () => {
    const api = new RealWhiteningApi();

    await expect(api.submitUnpack(Buffer.from("not an archive"), "junk.tgz", user)).rejects.toThrow(
      /Could not extract junk\.tgz/
    );
  });

  // Guards the exit-code handling: only unzip's code 1 ("warnings") is
  // survivable, and a corrupt zip exits higher than that.
  it("rejects a corrupt .zip rather than treating the failure as a warning", async () => {
    const api = new RealWhiteningApi();

    await expect(api.submitUnpack(Buffer.from("PK not really"), "junk.zip", user)).rejects.toThrow(
      /Could not extract junk\.zip/
    );
  });
});
