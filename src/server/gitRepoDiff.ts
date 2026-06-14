import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  BranchDiffDashboard,
  BranchDiffItem,
  BranchDiffMicroservice,
  BranchDiffRisk,
  BranchMicroserviceSnapshot
} from "./types";

const appName = "payments-app";
const branches = ["payments-tst", "payments-preprod", "payments-prd", "payments-secure-prd"];
const baselineBranch = "payments-prd";
const repoRoot = path.resolve(process.cwd(), "fake-repos", appName, "branches");

function hash(value: string) {
  return crypto.createHash("sha256").update(normalizeYaml(value)).digest("hex").slice(0, 12);
}

function normalizeYaml(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .join("\n");
}

function readIfExists(filePath: string) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : undefined;
}

function scalar(text: string | undefined, expression: RegExp) {
  return text?.match(expression)?.[1]?.replace(/^["']|["']$/g, "").trim();
}

function numberScalar(text: string | undefined, expression: RegExp) {
  const value = scalar(text, expression);
  return value ? Number(value) : undefined;
}

function valuesField(text: string | undefined, field: string) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return scalar(text, new RegExp(`^\\s*${escaped}:\\s*['"]?([^'"\\n]+)['"]?`, "m"));
}

function resourceIds(templateText: string | undefined) {
  return (templateText ?? "")
    .split(/^---$/m)
    .map((document) => {
      const kind = scalar(document, /^kind:\s*([^\n]+)/m);
      const name = scalar(document, /^\s+name:\s*([^\n]+)/m);
      const apiVersion = scalar(document, /^apiVersion:\s*([^\n]+)/m);
      return kind && name ? { kind, name, apiVersion: apiVersion ?? "" } : undefined;
    })
    .filter(Boolean) as Array<{ kind: string; name: string; apiVersion: string }>;
}

function documentLabel(document: string, index: number) {
  const kind = scalar(document, /^kind:\s*([^\n]+)/m) ?? `Document${index + 1}`;
  const name = scalar(document, /^\s+name:\s*([^\n]+)/m);
  return name ? `${kind}/${name}` : kind;
}

function flattenYamlDocument(document: string) {
  const values: Record<string, string> = {};
  const stack: Array<{ indent: number; path: string }> = [];
  const listIndexes = new Map<string, number>();

  for (const rawLine of document.replace(/\r\n/g, "\n").split("\n")) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;

    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    const line = rawLine.trim();
    if (line === "---") continue;

    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack.at(-1)?.path ?? "";

    if (line.startsWith("- ")) {
      const listKey = `${parent}|${indent}`;
      const index = listIndexes.get(listKey) ?? 0;
      listIndexes.set(listKey, index + 1);
      const itemPath = `${parent}[${index}]`;
      const item = line.slice(2).trim();
      stack.push({ indent, path: itemPath });

      const inline = item.match(/^([^:]+):\s*(.*)$/);
      if (inline) {
        const pathKey = `${itemPath}.${inline[1].trim()}`;
        const value = inline[2].trim();
        if (value) values[pathKey] = value.replace(/^["']|["']$/g, "");
      }
      continue;
    }

    const pair = line.match(/^([^:]+):\s*(.*)$/);
    if (!pair) continue;

    const key = pair[1].trim();
    const value = pair[2].trim();
    const pathKey = parent ? `${parent}.${key}` : key;

    if (value) {
      values[pathKey] = value.replace(/^["']|["']$/g, "");
    } else {
      stack.push({ indent, path: pathKey });
    }
  }

  return values;
}

function flattenYamlParameters(text: string | undefined) {
  const values: Record<string, string> = {};
  if (!text) return values;

  text
    .replace(/\r\n/g, "\n")
    .split(/^---$/m)
    .forEach((document, index) => {
      const label = documentLabel(document, index);
      for (const [key, value] of Object.entries(flattenYamlDocument(document))) {
        values[`${label}.${key}`] = value;
      }
    });

  return values;
}

function yamlParameterDiffs(
  snapshots: Record<string, BranchMicroserviceSnapshot>,
  getter: (snapshot: BranchMicroserviceSnapshot) => Record<string, string> | undefined
) {
  const keys = new Set<string>();
  for (const snapshot of Object.values(snapshots)) {
    for (const key of Object.keys(getter(snapshot) ?? {})) {
      keys.add(key);
    }
  }

  return Array.from(keys)
    .sort()
    .map((key) => {
      const values = Object.fromEntries(branches.map((branch) => [branch, getter(snapshots[branch])?.[key] ?? "missing"]));
      return { key, values };
    })
    .filter((field) => new Set(Object.values(field.values)).size > 1);
}

function toDiffItem(diff: { key: string; values: Record<string, string> }): BranchDiffItem {
  return { field: diff.key, values: diff.values };
}

function extractSnapshot(branch: string, microservice: string): BranchMicroserviceSnapshot {
  const templatePath = path.join(repoRoot, branch, "templates", `${microservice}.yaml`);
  const valuesPath = path.join(repoRoot, branch, "values", `${microservice}-values.yaml`);
  const template = readIfExists(templatePath);
  const values = readIfExists(valuesPath);

  if (!template && !values) {
    return { exists: false };
  }

  const resources = resourceIds(template);
  const valuesImageRepo = scalar(values, /^\s+repository:\s*([^\n]+)/m);
  const valuesImageTag = scalar(values, /^\s+tag:\s*["']?([^"'\n]+)["']?/m);
  const kinds = resources.map((resource) => resource.kind);
  const requestsCpu = scalar(values, /^\s+cpu:\s*("?[^"\n]+"?)\s*$/m);
  const requestsMemory = scalar(values, /^\s+memory:\s*("?[^"\n]+"?)\s*$/m);

  return {
    exists: true,
    templatePath: template ? `templates/${microservice}.yaml` : undefined,
    valuesPath: values ? `values/${microservice}-values.yaml` : undefined,
    templateHash: template ? hash(template) : undefined,
    valuesHash: values ? hash(values) : undefined,
    templateParameters: flattenYamlParameters(template),
    valuesParameters: flattenYamlParameters(values),
    imageRepository: valuesImageRepo,
    imageTag: valuesImageTag,
    replicaCount: numberScalar(values, /^replicaCount:\s*(\d+)/m) ?? numberScalar(template, /^\s+replicas:\s*(\d+)/m),
    routeHost: valuesField(values, "host") ?? scalar(template, /^\s+host:\s*([^\n]+)/m),
    resources: [
      requestsCpu ? `requests.cpu=${requestsCpu}` : "",
      requestsMemory ? `requests.memory=${requestsMemory}` : "",
      scalar(values, /^\s+limits:\s*\n\s+cpu:\s*([^\n]+)/m) ? "limits configured" : ""
    ].filter(Boolean),
    kinds,
    hasNetworkPolicy: kinds.includes("NetworkPolicy"),
    hasSecurityContext: Boolean(template?.includes("securityContext:")),
    serviceAccountName: scalar(template, /^\s+serviceAccountName:\s*([^\n]+)/m),
    hpa: {
      minReplicas: numberScalar(template, /^\s+minReplicas:\s*(\d+)/m),
      maxReplicas: numberScalar(template, /^\s+maxReplicas:\s*(\d+)/m)
    }
  };
}

function discoverMicroservices() {
  const names = new Set<string>();
  for (const branch of branches) {
    const templateDir = path.join(repoRoot, branch, "templates");
    const valuesDir = path.join(repoRoot, branch, "values");
    if (fs.existsSync(templateDir)) {
      for (const file of fs.readdirSync(templateDir)) {
        if (file.endsWith(".yaml")) names.add(file.replace(/\.yaml$/, ""));
      }
    }
    if (fs.existsSync(valuesDir)) {
      for (const file of fs.readdirSync(valuesDir)) {
        if (file.endsWith("-values.yaml")) names.add(file.replace(/-values\.yaml$/, ""));
      }
    }
  }
  return Array.from(names).sort();
}

function distinctValues(
  snapshots: Record<string, BranchMicroserviceSnapshot>,
  getter: (snapshot: BranchMicroserviceSnapshot) => string | number | boolean | undefined
) {
  return new Set(Object.values(snapshots).filter((snapshot) => snapshot.exists).map((snapshot) => String(getter(snapshot) ?? "")));
}

function fieldDiff(
  field: string,
  risk: BranchDiffRisk,
  snapshots: Record<string, BranchMicroserviceSnapshot>,
  getter: (snapshot: BranchMicroserviceSnapshot) => string | number | boolean | undefined
) {
  const values = Object.fromEntries(branches.map((branch) => [branch, String(getter(snapshots[branch]) ?? "missing")]));
  return { field, values, risk };
}

function highestRisk(...risks: BranchDiffRisk[]): BranchDiffRisk {
  if (risks.includes("high")) return "high";
  if (risks.includes("medium")) return "medium";
  return "low";
}

function analyzeMicroservice(name: string): BranchDiffMicroservice {
  const snapshots = Object.fromEntries(branches.map((branch) => [branch, extractSnapshot(branch, name)]));
  const baseline = snapshots[baselineBranch];
  const missingBranches = branches.filter((branch) => !snapshots[branch].exists);
  const templateDrift = branches.some((branch) => snapshots[branch].templateHash !== baseline.templateHash);
  const valuesDrift = branches.some((branch) => snapshots[branch].valuesHash !== baseline.valuesHash);
  const templateParameterDiffs = yamlParameterDiffs(snapshots, (snapshot) => snapshot.templateParameters);
  const valuesParameterDiffs = yamlParameterDiffs(snapshots, (snapshot) => snapshot.valuesParameters);
  const importantFields = [
    fieldDiff("image.tag", "low", snapshots, (snapshot) => snapshot.imageTag),
    fieldDiff("replicaCount", "low", snapshots, (snapshot) => snapshot.replicaCount),
    fieldDiff("route.host", "medium", snapshots, (snapshot) => snapshot.routeHost),
    fieldDiff("networkPolicy", "high", snapshots, (snapshot) => snapshot.hasNetworkPolicy),
    fieldDiff("securityContext", "high", snapshots, (snapshot) => snapshot.hasSecurityContext),
    fieldDiff("serviceAccountName", "high", snapshots, (snapshot) => snapshot.serviceAccountName),
    fieldDiff("hpa.maxReplicas", "medium", snapshots, (snapshot) => snapshot.hpa?.maxReplicas)
  ].filter((field) => new Set(Object.values(field.values)).size > 1);

  const valuesDiffs: BranchDiffItem[] = [];
  const templateDiffs: BranchDiffItem[] = [];
  const resourceDiffs: BranchDiffItem[] = [];
  const badges: string[] = [];
  const summary: string[] = [];
  const risks: BranchDiffRisk[] = [];

  function branchValues(getter: (s: BranchMicroserviceSnapshot) => string | number | boolean | undefined): Record<string, string> {
    return Object.fromEntries(branches.map((b) => [b, String(getter(snapshots[b]) ?? "missing")]));
  }

  if (missingBranches.length > 0) {
    badges.push("Missing");
    risks.push("high");
    summary.push(`${name} is missing from ${missingBranches.join(", ")}.`);
  }
  if (distinctValues(snapshots, (snapshot) => snapshot.imageTag).size > 1) {
    badges.push("Image differs");
    risks.push("low");
    valuesDiffs.push({ field: "image.tag", values: branchValues((s) => s.imageTag) });
    summary.push("Image tag differs across namespace branches.");
  }
  if (distinctValues(snapshots, (snapshot) => snapshot.replicaCount).size > 1) {
    badges.push("Replica differs");
    risks.push("low");
    valuesDiffs.push({ field: "replicaCount", values: branchValues((s) => s.replicaCount) });
    summary.push(`Replica count differs: ${branches.map((branch) => `${branch}=${snapshots[branch].replicaCount ?? "missing"}`).join(", ")}.`);
  }
  if (distinctValues(snapshots, (snapshot) => snapshot.routeHost).size > 1) {
    badges.push("Route changed");
    risks.push(name.includes("prd") ? "high" : "medium");
    valuesDiffs.push({ field: "route.host", values: branchValues((s) => s.routeHost) });
    summary.push("Route host differs between environments.");
  }
  if (distinctValues(snapshots, (snapshot) => snapshot.hasSecurityContext).size > 1) {
    badges.push("Security changed");
    risks.push("high");
    templateDiffs.push({ field: "securityContext", values: branchValues((s) => s.hasSecurityContext) });
    summary.push("Security context differs between namespace branches.");
  }
  if (distinctValues(snapshots, (snapshot) => snapshot.hasNetworkPolicy).size > 1) {
    badges.push("NetworkPolicy changed");
    risks.push("high");
    resourceDiffs.push({ field: "networkPolicy", values: branchValues((s) => s.hasNetworkPolicy) });
    summary.push("NetworkPolicy exists only in some branches.");
  }
  if (templateDrift) {
    badges.push("Template changed");
    templateDiffs.push(...(templateParameterDiffs.length > 0
      ? templateParameterDiffs.map(toDiffItem)
      : [{ field: "template.hash", values: branchValues((s) => s.templateHash) }]));
  }
  if (valuesDrift) {
    badges.push("Values changed");
    valuesDiffs.push(...(valuesParameterDiffs.length > 0
      ? valuesParameterDiffs.map(toDiffItem)
      : [{ field: "values.hash", values: branchValues((s) => s.valuesHash) }]));
  }
  if (snapshots["payments-prd"].templateHash !== snapshots["payments-preprod"].templateHash) {
    badges.push("Prod drift");
    risks.push("high");
    summary.push("Production template differs from preprod.");
  }
  if (snapshots["payments-secure-prd"].templateHash !== snapshots["payments-prd"].templateHash) {
    badges.push("Secure drift");
    risks.push("medium");
    summary.push("Secure production differs from regular production.");
  }

  if (summary.length === 0) {
    summary.push("No meaningful branch differences detected.");
  }

  const riskLevel = highestRisk(...risks);

  return {
    name,
    branches: snapshots,
    summary,
    importantFields,
    valuesDiffs,
    templateDiffs,
    resourceDiffs,
    riskLevel,
    templateDrift,
    valuesDrift,
    missingBranches,
    productionDifference: badges.includes("Prod drift"),
    secureDifference: badges.includes("Secure drift"),
    badges: Array.from(new Set(badges.length > 0 ? badges : ["Same"]))
  };
}

export function getBranchDiffDashboard(): BranchDiffDashboard {
  const microservices = discoverMicroservices().map(analyzeMicroservice);

  return {
    app: appName,
    branches,
    baselineBranch,
    lastScannedAt: new Date().toISOString(),
    summary: {
      totalBranches: branches.length,
      totalMicroservices: microservices.length,
      sameAcrossAllBranches: microservices.filter((service) => !service.templateDrift && !service.valuesDrift && service.missingBranches.length === 0).length,
      valuesDrift: microservices.filter((service) => service.valuesDrift).length,
      templateDrift: microservices.filter((service) => service.templateDrift).length,
      missingMicroservices: microservices.filter((service) => service.missingBranches.length > 0).length,
      highRiskDifferences: microservices.filter((service) => service.riskLevel === "high").length,
      productionDifferences: microservices.filter((service) => service.productionDifference).length,
      secureNetworkDifferences: microservices.filter((service) => service.secureDifference).length
    },
    microservices
  };
}
