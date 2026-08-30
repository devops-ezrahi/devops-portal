import { execFile } from "child_process";
import { mkdtempSync } from "fs";
import { mkdir, mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { crc32 } from "zlib";
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
 * Minimal stored (uncompressed) zip writer — enough for `unzip` to read back.
 *
 * ponytail: hand-rolled over shelling out to `zip`, because `zip` is not
 * installed everywhere `unzip` is (Debian without zip, Git Bash) and this
 * fixture builder was the only thing in the suite needing a binary the app
 * never calls. Stored-only and no zip64, which a two-entry fixture never hits.
 */
function zipOf(entries: [name: string, content: string][]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);

    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0, 8); // method: stored
    head.writeUInt16LE(0x0021, 12); // 1980-01-01 — 0 is not a valid DOS date
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    local.push(head, nameBuf, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 10); // method: stored
    entry.writeUInt16LE(0x0021, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);

    offset += head.length + nameBuf.length + data.length;
  }

  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...local, dir, end]);
}

/** Build a pack tree, then archive it in the requested format. */
async function buildArchive(format: "tgz" | "zip"): Promise<Buffer> {
  if (format === "zip") {
    return zipOf([
      ["repository/devops-portal/", ""],
      ["repository/config.json", JSON.stringify(packConfig)],
    ]);
  }
  const dir = await mkdtemp(join(tmpdir(), "pack-tgz-"));
  await mkdir(join(dir, "repository", "devops-portal"), { recursive: true });
  await writeFile(join(dir, "repository", "config.json"), JSON.stringify(packConfig));
  await execFileAsync("tar", ["-czf", "pack.tgz", "repository"], { cwd: dir });
  return readFile(join(dir, "pack.tgz"));
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
