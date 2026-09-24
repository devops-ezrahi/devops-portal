import { describe, expect, it } from "vitest";
import { BY_ID, featureForPath } from "./catalog";
import { checkValues } from "./checks";
import { ENV_SPECIFIC_PATHS } from "./promote";
import type { Values } from "./values";

describe("featureForPath", () => {
  // A per-namespace warning is a problem like any other, so its jump has to
  // land on a real card — a path no feature owns is a row that goes nowhere.
  it("finds a catalog feature for every path the per-namespace warning names", () => {
    ENV_SPECIFIC_PATHS.forEach((path) => expect(BY_ID[featureForPath(path) ?? ""], path).toBeDefined());
    expect(featureForPath("image.tag")).toBe("image");
    expect(featureForPath("replicaCount")).toBe("replicas");
  });
});

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
    expect(
      say(withImage({
        volumes: { cfg: { configMap: { name: "c" } } },
        volumeMounts: { "cfg:a.properties": { name: "cfg", mountPath: "/a", subPath: "a.properties" } },
      }))
    ).not.toContain("has no matching volume");
    expect(say(withImage({ volumes: { data: { emptyDir: { sizeLimit: "1Gi" } } }, volumeMounts: { data: { mountPath: "/var/data" } } }))).toBe("");
  });

  it("catches a nodePort on a ClusterIP Service, primary or extra", () => {
    const ports = { http: { port: 80, nodePort: 30080 } };
    expect(say(withImage({ service: { enabled: true, ports } }))).toContain("is ClusterIP but sets a nodePort");
    expect(say(withImage({ services: { admin: { enabled: true, ports } } }))).toContain("Service admin is ClusterIP");
    expect(say(withImage({ service: { enabled: true, type: "NodePort", ports } }))).toBe("");
  });

  it("catches an emptyDir with no sizeLimit", () => {
    expect(say(withImage({ volumes: { scratch: { emptyDir: {} } } }))).toContain("emptyDir scratch has no sizeLimit");
  });

  it("catches a PVC bound to a PersistentVolume nothing creates", () => {
    expect(say(withImage({ pvc: { data: { volumeName: "pv-data" } } }))).toContain("stays Pending");
    expect(say(withImage({ pvc: { data: { volumeName: "pv-data" } }, persistentVolumes: { "pv-data": {} } }))).toBe("");
  });

  it("catches the Redis settings that lose data or flap", () => {
    const cm = (conf: string) => withImage({ configMaps: { redis: { data: { "redis.conf": conf } } } });
    expect(say(cm("port 6379\ndir /tmp\n"))).toContain("lost on restart");
    expect(say(cm("sentinel down-after-milliseconds mymaster 1000\n"))).toContain("triggers a failover");
    expect(say(cm("dir /data\nsentinel down-after-milliseconds mymaster 30000\n"))).toBe("");
  });

  it("catches a ReadWriteOnce claim shared by several replicas", () => {
    expect(say(withImage({ replicaCount: 3, pvc: { data: { size: "10Gi" } } }))).toContain("stays Pending");
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
  /**
   * The ids are hand-written, and a typo makes a problem that looks pressable
   * and then jumps nowhere — which is worse than not linking it at all.
   */
  it("names a real catalog feature on every problem that carries one", () => {
    const docs: Values[] = [
      { workload: { type: "none" }, hpa: { enabled: true }, vpa: { enabled: true }, pdb: { enabled: true }, service: { enabled: true } },
      { ingress: { enabled: true }, route: { enabled: true } },
      withImage({ workload: { type: "daemonset" }, hpa: { enabled: true } }),
      withImage({ hpa: { enabled: true }, replicaCount: 3 }),
      withImage({ volumeClaimTemplates: { data: { size: "1Gi" } } }),
      withImage({ pdb: { minAvailable: 2 }, replicaCount: 2 }),
      withImage({ pvc: { data: {} }, replicaCount: 2 }),
      withImage({ securityContext: { readOnlyRootFilesystem: true } }),
      withImage({ serviceMonitor: { enabled: true } }),
      withImage({ volumeMounts: { data: { mountPath: "/data" } } }),
      withImage({ jobs: { migrate: { serviceAccountName: "seeder-sa" } } }),
      { workload: { type: "statefulset" }, service: { enabled: true } },
      withImage({ service: { ports: { http: { port: 80, nodePort: 30080 } } }, services: { admin: { ports: { a: { port: 1, nodePort: 30081 } } } } }),
      withImage({ volumes: { scratch: { emptyDir: {} } }, pvc: { data: { volumeName: "pv" } } }),
      withImage({ configMaps: { redis: { data: { conf: "dir /tmp" } } } }),
      {},
    ];
    const seen = new Set<string>();
    for (const doc of docs)
      for (const problem of checkValues(doc)) {
        if (!problem.feature) continue;
        seen.add(problem.feature);
        expect(BY_ID[problem.feature], `${problem.feature} is not a catalog feature`).toBeDefined();
      }
    // Not just "the ones that happen to be set" — the sweep has to have covered
    // real ground, or the assertion above passes on an empty loop.
    expect(seen.size).toBeGreaterThan(8);
  });
});
