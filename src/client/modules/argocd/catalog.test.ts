import { describe, expect, it } from "vitest";
import { BY_ID, CATEGORIES, FEATURES, defaultValues } from "./catalog";
import { buildValues } from "./build";
import { toYaml } from "./yaml";

const on = (id: string, v: Record<string, unknown>) => ({ [id]: { on: true, v } });

describe("catalog", () => {
  it("gives every feature a category the index renders", () => {
    const known = new Set(CATEGORIES.map((c) => c.id));
    expect(FEATURES.filter((f) => !known.has(f.cat as never))).toEqual([]);
  });

  it("has no duplicate feature ids or duplicate ownership of a values key", () => {
    expect(new Set(FEATURES.map((f) => f.id)).size).toBe(FEATURES.length);
    const keys = FEATURES.flatMap((f) => f.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("emits nothing for a feature switched on and left blank", () => {
    // Everything except the handful that carry a meaningful default (`enabled`,
    // a workload type) must stay out of the file until something is typed.
    const alwaysEmits = ["workload", "service", "ingress", "route", "hpa", "vpa", "pdb", "serviceaccount", "servicemonitor", "checksums"];
    for (const spec of FEATURES) {
      if (alwaysEmits.includes(spec.id)) continue;
      expect([spec.id, spec.emit(defaultValues(spec.id))]).toEqual([spec.id, null]);
    }
  });

  it("groups ingress paths by host and writes TLS hosts in flow style", () => {
    const yaml = toYaml(
      buildValues(
        on("ingress", {
          className: "nginx",
          hosts: [
            { host: "api.example.com", path: "/v1", portName: "http" },
            { host: "api.example.com", path: "/v2", portName: "http" },
            { host: "admin.example.com", path: "/" },
          ],
          tls: [{ secretName: "api-tls", hosts: "api.example.com, admin.example.com" }],
        })
      )
    );
    expect(yaml).toContain("hosts:\n    - host: api.example.com\n      paths:\n        - path: /v1");
    expect(yaml).toContain("      - path: /v2");
    expect(yaml).toContain("hosts: [api.example.com, admin.example.com]");
  });

  it("writes each probe under its own key, with the port typed as it was written", () => {
    const doc = buildValues(
      on("probes", {
        items: [
          { which: "readinessProbe", kind: "httpGet", path: "/healthz", port: "http" },
          { which: "livenessProbe", kind: "tcpSocket", port: "8080", failureThreshold: "3" },
        ],
      })
    );
    expect(doc.readinessProbe).toEqual({ httpGet: { path: "/healthz", port: "http" } });
    expect(doc.livenessProbe).toEqual({ tcpSocket: { port: 8080 }, failureThreshold: 3 });
  });

  it("reads a job env line as a value or a secret reference", () => {
    const doc = buildValues(
      on("jobs", { items: [{ name: "migrate", env: "LOG_LEVEL=info\nDATABASE_URL@secret:db-secret/DATABASE_URL" }] })
    ) as { jobs: Record<string, { env: Record<string, unknown> }> };
    expect(doc.jobs.migrate.env).toEqual({
      LOG_LEVEL: { value: "info" },
      DATABASE_URL: { valueFrom: { secretKeyRef: { name: "db-secret", key: "DATABASE_URL" } } },
    });
  });

  it("keeps a percentage a string and a count a number on the PDB", () => {
    expect(buildValues(on("pdb", { minAvailable: "50%" })).pdb).toEqual({ enabled: true, minAvailable: "50%" });
    expect(buildValues(on("pdb", { minAvailable: "2" })).pdb).toEqual({ enabled: true, minAvailable: 2 });
  });

  it("orders keys by the catalog, not by the order they were typed", () => {
    const doc = buildValues({
      ...on("hpa", { maxReplicas: "5" }),
      ...on("image", { repository: "nginx" }),
      ...on("identity", { nameOverride: "web" }),
    });
    expect(Object.keys(doc)).toEqual(["nameOverride", "image", "hpa"]);
  });

  it("merges extraValues last, so the escape hatch wins", () => {
    const doc = buildValues(on("image", { repository: "nginx", tag: "1.0" }), "image:\n  tag: 2.0\npodAnnotations:\n  a: b");
    expect(doc.image).toEqual({ repository: "nginx", tag: 2 });
    expect(doc.podAnnotations).toEqual({ a: "b" });
  });

  it("round-trips every feature that claims it can read a document back", () => {
    // A `load` is the inverse of an `emit`, and the importer leans on that.
    const cases: Record<string, Record<string, unknown>> = {
      identity: { nameOverride: "web", commonLabels: [{ k: "team", v: "payments" }] },
      image: { repository: "nginx", tag: "1.2.3", pullSecrets: "ghcr-pull" },
      env: { items: [{ name: "LOG_LEVEL", kind: "value", value: "debug" }] },
      ports: { items: [{ name: "http", port: "8080", protocol: "TCP" }] },
      resources: { rcpu: "200m", rmem: "256Mi", lcpu: "1", lmem: "1Gi" },
      service: { enabled: true, type: "ClusterIP", ports: "http=80:http" },
      podmeta: { podLabels: [{ k: "tier", v: "backend" }] },
    };
    for (const [id, v] of Object.entries(cases)) {
      const spec = BY_ID[id];
      const doc = spec.emit(v)!;
      const reloaded = spec.load!(doc);
      expect([id, spec.emit(reloaded)]).toEqual([id, doc]);
    }
  });
});
