import { describe, expect, it } from "vitest";
import { addedKinds, resourcesOf } from "./resources";

/** The kinds only — what the card's chips read. */
const kinds = (doc: Parameters<typeof resourcesOf>[0]) => resourcesOf(doc).map((r) => r.kind);

describe("resourcesOf", () => {
  it("names every object a release creates, workload first", () => {
    const doc = {
      workload: { type: "statefulset" },
      image: { repository: "nginx", tag: "1.27" },
      service: { enabled: true, ports: { http: { port: 80 } } },
      route: { enabled: true, host: "app.example.com" },
      configMaps: { "app-config": {}, "feature-flags": {} },
      pvc: { data: { size: "10Gi" } },
      hpa: { enabled: true, minReplicas: 2, maxReplicas: 8 },
      serviceAccount: { create: true, name: "app-sa" },
    };
    expect(kinds(doc)).toEqual([
      "StatefulSet",
      "Service",
      "Route",
      "ConfigMap",
      "PersistentVolumeClaim",
      "HorizontalPodAutoscaler",
      "ServiceAccount",
    ]);
    // One chip per kind, with the object names behind it — two ConfigMaps are
    // one row reading "ConfigMap ×2", not two rows saying the same word.
    expect(resourcesOf(doc).find((r) => r.kind === "ConfigMap")?.names).toEqual(["app-config", "feature-flags"]);
  });

  it("counts what the document says, not what a feature was switched on for", () => {
    // `enabled: false` is a Service the chart does not render, and
    // `create: false` is a ServiceAccount somebody else owns.
    expect(kinds({ service: { enabled: false }, serviceAccount: { create: false, name: "shared-sa" } })).toEqual([
      "Deployment",
    ]);
    // An absent workload key is a Deployment — that is the chart's own default.
    expect(kinds({})).toEqual(["Deployment"]);
    // ...and `none` is a release that owns no pods at all. Its first object is
    // an ordinary ConfigMap, so nothing may present it as the workload.
    const configOnly = resourcesOf({ workload: { type: "none" }, configMaps: { flags: {} } });
    expect(configOnly.map((r) => r.kind)).toEqual(["ConfigMap"]);
    expect(configOnly.some((r) => r.scope === "workload")).toBe(false);
    expect(resourcesOf({}).find((r) => r.scope === "workload")?.kind).toBe("Deployment");
  });

  it("folds the primary and the extra objects of a kind into one chip", () => {
    const doc = { service: { enabled: true }, services: { headless: {}, metrics: {} } };
    expect(resourcesOf(doc).find((r) => r.kind === "Service")?.names).toEqual(["headless", "metrics"]);
  });

  it("reads an extraDeploy manifest for its own kind", () => {
    const doc = {
      workload: { type: "none" },
      extraDeploy: ["apiVersion: monitoring.coreos.com/v1\nkind: PrometheusRule\nmetadata:\n  name: x\n", "no kind here\n"],
    };
    expect(kinds(doc)).toEqual(["PrometheusRule", "extraDeploy"]);
  });

  it("separates what is part of the workload from what is an object of its own", () => {
    // The trap this exists to close: `volumeClaimTemplates` really does end up
    // as PersistentVolumeClaims, but they are minted by the StatefulSet and die
    // with it — so showing them exactly like the standalone `pvc` below said
    // two different things in the same words.
    const doc = {
      workload: { type: "statefulset" },
      volumeClaimTemplates: { data: { size: "50Gi" } },
      volumes: { config: { configMap: { name: "app-config" } } },
      sidecars: { envoy: {} },
      pvc: { shared: { size: "5Gi" } },
      persistentVolumes: { nfs: {} },
      rbac: { roles: { reader: {} }, clusterRoles: { admin: {} } },
    };
    const byScope = (scope: string) =>
      resourcesOf(doc)
        .filter((r) => r.scope === scope)
        .map((r) => r.kind);

    expect(byScope("workload")).toEqual(["StatefulSet"]);
    expect(byScope("pod")).toEqual(["Sidecar", "Volume", "PVC per replica"]);
    expect(byScope("object")).toEqual(["PersistentVolumeClaim", "Role"]);
    expect(byScope("cluster")).toEqual(["PersistentVolume", "ClusterRole"]);

    // Grouped, so the card can render them in bands without sorting itself.
    expect(kinds(doc)).toEqual([
      "StatefulSet",
      "Sidecar",
      "Volume",
      "PVC per replica",
      "PersistentVolumeClaim",
      "Role",
      "PersistentVolume",
      "ClusterRole",
    ]);
  });

  it("says what an override adds on top of the base", () => {
    const base = resourcesOf({ service: { enabled: true } });
    const over = resourcesOf({ service: { enabled: true }, serviceMonitor: { enabled: true, port: "metrics" } });
    expect(addedKinds(base, over)).toEqual(["ServiceMonitor"]);
    expect(addedKinds(over, base)).toEqual([]);
  });
});
