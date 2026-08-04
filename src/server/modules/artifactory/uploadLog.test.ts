import { describe, expect, it, vi } from "vitest";
import type { PortalUser, UploadedFile } from "../../types";

vi.mock("../../config", () => ({
  config: {
    // A realistic token, not "t" — redactSecrets would blank every letter t in the log.
    artifactory: { url: "https://art.example.com", repo: "npm-local", token: "AKCp8-fake-token" },
    git: { token: "" }, // redactSecrets reads both
  },
}));

// Real tar still runs; only the network is faked. `arg` is already in the repo,
// `@babel/core` is rejected by Artifactory — one job showing all three outcomes.
vi.mock("./artifactoryRest", () => ({
  exists: async (path: string) => path.includes("/arg/"),
  upload: async (path: string) => {
    if (path.includes("@babel")) {
      throw new Error("Artifactory responded 403 Forbidden: deploy denied for path");
    }
  },
  webUrl: (path: string) => `https://art.example.com/ui/tree/General/${path}`,
}));

const { RealArtifactoryApi } = await import("./RealArtifactoryApi");

function pkg(dir: string, name: string, version: string): UploadedFile[] {
  return [
    {
      originalname: `${dir}/package.json`,
      mimetype: "application/json",
      buffer: Buffer.from(JSON.stringify({ name, version, main: "index.js" })),
    },
    { originalname: `${dir}/index.js`, mimetype: "text/javascript", buffer: Buffer.from("module.exports = 1;\n") },
  ];
}

const user: PortalUser = {
  id: "dana",
  displayName: "Dana Levi",
  email: "dana@example.com",
  groups: [],
};

describe("folder upload log", () => {
  it("reports skipped, uploaded and failed packages", async () => {
    const files = [
      ...pkg("node_modules/arg", "arg", "4.1.5"),
      ...pkg("node_modules/left-pad", "left-pad", "1.3.0"),
      ...pkg("node_modules/@babel/core", "@babel/core", "7.24.0"),
    ];

    const api = new RealArtifactoryApi();
    const { id } = await api.submitFolderUpload(
      {
        folderName: "node_modules",
        fileCount: files.length,
        totalBytes: files.reduce((n, f) => n + f.buffer.length, 0),
        files,
      },
      user
    );

    let job = await api.getJob(id);
    while (job && (job.status === "pending" || job.status === "in-progress")) {
      await new Promise((r) => setTimeout(r, 20));
      job = await api.getJob(id);
    }

    console.log(`\n--- ${id} (${job!.status}) ---\n${job!.log.join("\n")}\n`);

    expect(job!.status).toBe("failed");
    expect(job!.log).toContain("Uploaded left-pad@1.3.0");
    expect(job!.log.some((l) => l.includes("1 package(s) already in the repo"))).toBe(true);
    expect(job!.log.some((l) => l.startsWith("Failed @babel/core@7.24.0:"))).toBe(true);
    expect(job!.log.at(-1)).toBe("Done. 1 uploaded, 1 already present, 1 failed.");
  });
});
