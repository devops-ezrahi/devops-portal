import { describe, expect, it } from "vitest";
import { checkValues } from "./checks";
import type { Values } from "./values";

const say = (doc: Values) => checkValues(doc).map((p) => `${p.level}: ${p.text}`).join("\n");
const withImage = (doc: Values): Values => ({ image: { repository: "nginx" }, ...doc });

describe("checkValues", () => {
  it("passes a plain deployment", () => {
    expect(checkValues(withImage({ workload: { type: "deployment" } }))).toEqual([]);
  });

  it("catches the two the chart itself refuses to render", () => {
    expect(say(withImage({ ingress: { enabled: true }, route: { enabled: true } }))).toContain("cannot both be true");
    expect(say(withImage({ workload: { type: "daemonset" }, hpa: { enabled: true } }))).toContain("not supported for a DaemonSet");
  });

  it("catches the pair that quietly fight at runtime", () => {
    expect(say(withImage({ hpa: { enabled: true }, replicaCount: 3 }))).toContain("scales it away again");
    const cpuHpa = { enabled: true, metrics: [{ resource: { name: "cpu", target: { type: "Utilization" } } }] };
    expect(say(withImage({ hpa: cpuHpa }))).toContain("needs resources.requests.cpu");
    expect(say(withImage({ hpa: cpuHpa, vpa: { enabled: true }, resources: { requests: { cpu: "100m" } } }))).toContain("fight each other");
  });

  it("catches a disruption budget that blocks every drain", () => {
    expect(say(withImage({ replicaCount: 2, pdb: { enabled: true, minAvailable: 2 } }))).toContain("drains hang forever");
  });

  it("catches a mount with no volume behind it", () => {
    expect(say(withImage({ volumeMounts: { data: { mountPath: "/var/data" } } }))).toContain("has no matching volume");
    expect(say(withImage({ volumes: { data: { emptyDir: {} } }, volumeMounts: { data: { mountPath: "/var/data" } } }))).toBe("");
  });

  it("catches a ReadWriteOnce claim shared by several replicas", () => {
    expect(say(withImage({ replicaCount: 3, pvc: { data: { size: "10Gi" } } }))).toContain("stays Pending");
  });

  it("catches host networking without the matching DNS policy", () => {
    expect(say(withImage({ hostNetwork: true }))).toContain("no Service name resolves");
    expect(say(withImage({ hostNetwork: true, dnsPolicy: "ClusterFirstWithHostNet" }))).toBe("");
  });

  it("catches a workload with no image, and does not ask a config-only release for one", () => {
    expect(say({ workload: { type: "deployment" } })).toContain("No image.repository");
    expect(say({ workload: { type: "none" } })).toBe("");
  });

  it("catches the scale objects a config-only release cannot have", () => {
    expect(say({ workload: { type: "none" }, hpa: { enabled: true } })).toContain("no pods to scale");
  });

  it("catches volumeClaimTemplates off a StatefulSet, and their missing retention policy", () => {
    expect(say(withImage({ volumeClaimTemplates: { data: { size: "1Gi" } } }))).toContain("StatefulSet-only");
    expect(say(withImage({ workload: { type: "statefulset" }, volumeClaimTemplates: { data: { size: "1Gi" } } }))).toContain(
      "deleting the StatefulSet deletes the data"
    );
  });

  it("catches a ServiceMonitor nothing will ever scrape", () => {
    expect(say(withImage({ serviceMonitor: { enabled: true } }))).toContain("silently never scraped");
    expect(say(withImage({ serviceMonitor: { enabled: true, labels: { release: "prometheus" }, port: "metrics" }, service: { ports: { http: { port: 80 } } } }))).toContain(
      "not one of the Service ports"
    );
  });

  it("catches a batch entry naming a ServiceAccount nothing creates", () => {
    expect(say(withImage({ jobs: { migrate: { serviceAccountName: "seeder-sa" } } }))).toContain("nothing in this release creates it");
    expect(say(withImage({ jobs: { migrate: { serviceAccountName: "seeder-sa" } }, serviceAccount: { name: "seeder-sa" } }))).toBe("");
  });
});
