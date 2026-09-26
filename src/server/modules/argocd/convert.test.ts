import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
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
      yaml: DEPLOYMENT,
    });
    const paths = files.map((f) => f.path);
    expect(paths).toContain("base/stalker.yaml");
    expect(paths).toContain("interconn/values/stalker.yaml");
    expect(paths.some((p) => p.startsWith("report/"))).toBe(false);
    const all = files.map((f) => f.text).join("\n");
    expect(all).toContain("registry.example.com/team/stalker");
    expect(all).toContain("MODE");
  }, 120_000);

  it("splits a dirty kubectl dump into microservices, like the namespace importer", async () => {
    const dump = `apiVersion: v1
kind: List
items:
  - apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: orders
      namespace: shop
      uid: 1b2c
      resourceVersion: "991"
      managedFields: [{ manager: kubectl }]
      annotations: { deployment.kubernetes.io/revision: "7" }
    spec:
      selector: { matchLabels: { app: orders } }
      template:
        metadata: { labels: { app: orders } }
        spec:
          containers:
            - name: orders
              image: registry.example.com/orders:2.0.0
              envFrom: [{ secretRef: { name: orders-db } }]
    status: { readyReplicas: 1 }
  - apiVersion: apps/v1
    kind: ReplicaSet
    metadata: { name: orders-5d8f, namespace: shop }
  - apiVersion: v1
    kind: Service
    metadata: { name: orders, namespace: shop }
    spec:
      selector: { app: orders }
      ports: [{ port: 80, targetPort: 8080 }]
      clusterIP: 10.0.0.12
---
${DEPLOYMENT}`;
    const { files, warnings } = await convertToUniversal({ chartRepoUrl: chartRepo, chartRevision: branch, namespace: "shop", yaml: dump });
    const paths = files.map((f) => f.path);
    expect(paths).toContain("base/orders.yaml");
    expect(paths).toContain("base/stalker.yaml");
    const all = files.map((f) => f.text).join("\n");
    expect(all).not.toMatch(/managedFields|resourceVersion|readyReplicas|10\.0\.0\.12|orders-5d8f/);
    expect(warnings.join("\n")).toMatch(/orders-db.*not in the pasted YAML/);
  }, 120_000);

  it("puts each --env-group token in its own variant folder", async () => {
    const colour = (c: string) => DEPLOYMENT.replace(/stalker/g, `stalker-${c}`).replace("MODE", `COLOR\n              value: ${c}\n            - name: MODE`);
    const { files } = await convertToUniversal({
      chartRepoUrl: chartRepo,
      chartRevision: branch,
      namespace: "interconn",
      envGroups: ["color=black,yellow"],
      yaml: `${colour("black")}---\n${colour("yellow")}`,
    });
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["base/stalker.yaml", "interconn/black/values/stalker.yaml", "interconn/yellow/defaults.yaml"]));
    expect(files.find((f) => f.path === "base/stalker.yaml")!.text).toContain("{{ .Values.color }}");
    expect(files.find((f) => f.path === "interconn/yellow/defaults.yaml")!.text).toMatch(/^color: yellow$/m);
  }, 120_000);

  it("gives each metadata.namespace its own folder, like the converter's input folders", async () => {
    const orders = DEPLOYMENT.replace(/stalker/g, "orders").replace("namespace: interconn", "namespace: shop");
    const unscoped = DEPLOYMENT.replace(/stalker/g, "billing").replace("  namespace: interconn\n", "");
    const { files } = await convertToUniversal({
      chartRepoUrl: chartRepo,
      chartRevision: branch,
      namespace: "fallback",
      yaml: `${DEPLOYMENT}---\n${orders}---\n${unscoped}`,
    });
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining(["interconn/values/stalker.yaml", "shop/values/orders.yaml", "fallback/values/billing.yaml"])
    );
    expect(paths).not.toContain("interconn/values/orders.yaml");
  }, 120_000);

  it("keeps the release name, image repository and tag out of base", async () => {
    const { files } = await convertToUniversal({ chartRepoUrl: chartRepo, chartRevision: branch, namespace: "interconn", yaml: DEPLOYMENT });
    const base = files.find((f) => f.path === "base/stalker.yaml")!.text;
    const values = files.find((f) => f.path === "interconn/values/stalker.yaml")!.text;
    expect(base).not.toMatch(/nameOverride|repository:|tag:/);
    expect(values).toMatch(/repository: registry\.example\.com\/team\/stalker/);
    // One blank line between top-level keys, and the workload before everything else.
    expect(base).toMatch(/^workload:[\s\S]*\r?\n\r?\n\w/m);
  }, 120_000);

  it.skipIf(!has("helm", ["version"]))("renders a packaged Helm chart under its own name, one microservice per workload", async () => {
    execFileSync("helm", ["create", "webapp"], { cwd: work });
    writeFileSync(
      join(work, "webapp", "templates", "worker.yaml"),
      `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-worker
spec:
  selector: { matchLabels: { app: worker } }
  template:
    metadata: { labels: { app: worker } }
    spec:
      containers:
        - name: worker
          image: registry.example.com/worker:1.0.0
`
    );
    execFileSync("helm", ["package", "webapp"], { cwd: work });
    const archive = readFileSync(join(work, "webapp-0.1.0.tgz")).toString("base64");
    const { files } = await convertToUniversal({
      chartRepoUrl: chartRepo,
      chartRevision: branch,
      namespace: "shop",
      helm: { archive, values: "replicaCount: 3\n" },
    });
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["base/webapp.yaml", "base/webapp-worker.yaml", "shop/values/webapp-worker.yaml"]));
    expect(files.map((f) => f.text).join("\n")).toMatch(/replicaCount: 3/);
  }, 120_000);

  it("says so when the chart repo carries no converter", async () => {
    await expect(
      convertToUniversal({
        chartRepoUrl: resolve(__dirname, "../../../.."),
        chartRevision: execFileSync("git", ["branch", "--show-current"]).toString().trim(),
        namespace: "x",
        yaml: DEPLOYMENT,
      })
    ).rejects.toThrow(/has no gitops-factory\/convert_to_universal_chart.py/);
  }, 120_000);
});
