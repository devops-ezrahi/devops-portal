import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { afterAll, describe, expect, it } from "vitest";
import { convertToUniversal } from "./convert";

// The real converter, from a universal-chart checkout beside this repo. Its
// own repo is the chart repo a tree points at, so cloning it here is exactly
// what a deployment does. Skipped where that checkout (or Python) is absent.
const chartRepo = resolve(__dirname, "../../../../../universal-chart");
const has = (cmd: string, args: string[]) => {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const python = process.platform === "win32" ? "python" : "python3";
const canConvert = existsSync(join(chartRepo, ".git")) && has(python, ["-c", "import yaml"]);
const branch = canConvert ? execFileSync("git", ["-C", chartRepo, "branch", "--show-current"]).toString().trim() : "";

const DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: stalker
  namespace: interconn
spec:
  replicas: 2
  selector:
    matchLabels: { app: stalker }
  template:
    metadata:
      labels: { app: stalker }
    spec:
      containers:
        - name: stalker
          image: registry.example.com/team/stalker:1.2.3
          env:
            - name: MODE
              value: production
`;

describe.skipIf(!canConvert)("convertToUniversal", () => {
  const work = mkdtempSync(join(tmpdir(), "convert-test-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("turns plain manifests into base/ and <ns>/values/ files", async () => {
    const { files } = await convertToUniversal({
      chartRepoUrl: chartRepo,
      chartRevision: branch,
      namespace: "interconn",
      manifests: [{ name: "stalker", text: DEPLOYMENT }],
    });
    const paths = files.map((f) => f.path);
    expect(paths).toContain("base/stalker.yaml");
    expect(paths).toContain("interconn/values/stalker.yaml");
    expect(paths.some((p) => p.startsWith("report/"))).toBe(false);
    const all = files.map((f) => f.text).join("\n");
    expect(all).toContain("registry.example.com/team/stalker");
    expect(all).toContain("MODE");
  }, 120_000);

  it.skipIf(!has("helm", ["version"]))("renders a packaged Helm chart first", async () => {
    execFileSync("helm", ["create", "webapp"], { cwd: work });
    execFileSync("helm", ["package", "webapp"], { cwd: work });
    const archive = readFileSync(join(work, "webapp-0.1.0.tgz")).toString("base64");
    const { files } = await convertToUniversal({
      chartRepoUrl: chartRepo,
      chartRevision: branch,
      namespace: "shop",
      helm: { name: "webapp", archive, values: "replicaCount: 3\n" },
    });
    expect(files.map((f) => f.path)).toContain("base/webapp.yaml");
    expect(files.map((f) => f.text).join("\n")).toMatch(/replicaCount: 3/);
  }, 120_000);

  it("says so when the chart repo carries no converter", async () => {
    await expect(
      convertToUniversal({
        chartRepoUrl: resolve(__dirname, "../../../.."),
        chartRevision: execFileSync("git", ["branch", "--show-current"]).toString().trim(),
        namespace: "x",
        manifests: [{ name: "a", text: DEPLOYMENT }],
      })
    ).rejects.toThrow(/has no gitops-factory\/convert_to_universal_chart.py/);
  }, 120_000);
});
