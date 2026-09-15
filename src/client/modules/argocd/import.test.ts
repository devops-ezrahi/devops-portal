import { describe, expect, it } from "vitest";
import { importValues } from "./import";
import { buildValues } from "./build";
import { toYaml } from "./yaml";

const round = (text: string) => {
  const { features, extraValues } = importValues(text);
  return toYaml(buildValues(features, extraValues));
};

describe("importValues", () => {
  it("fills the form from a values file", () => {
    const { features } = importValues(`
nameOverride: checkout-api
workload:
  type: statefulset
image:
  repository: registry/checkout
  tag: "1.4.2"
replicaCount: 3
`);
    expect(features.identity.v.nameOverride).toBe("checkout-api");
    expect(features.workload.v.type).toBe("statefulset");
    expect(features.image.v).toMatchObject({ repository: "registry/checkout", tag: "1.4.2" });
    expect(features.replicas.v.replicaCount).toBe("3");
  });

  it("switches on only the features the document mentions", () => {
    const { features } = importValues("replicaCount: 2\n");
    expect(Object.keys(features)).toEqual(["replicas"]);
  });

  it("keeps what the catalog cannot show, and says so", () => {
    const { extraValues, warnings } = importValues(`
image:
  repository: nginx
somethingTheChartAdded:
  a: 1
`);
    expect(extraValues).toContain("somethingTheChartAdded");
    expect(warnings.join(" ")).toContain("somethingTheChartAdded");
  });

  it("keeps the part of a modelled key the form cannot hold, naming the form", () => {
    // `ports` is a map the form can show; a key the form has no field for
    // still has to survive the round trip.
    const { extraValues, warnings } = importValues("ports:\n  http:\n    containerPort: 8080\n    hostPort: 8080\n");
    expect(extraValues).toContain("hostPort");
    expect(warnings.join(" ")).toContain("Container ports");
  });

  it("round-trips a document it fully understands", () => {
    const source = ["image:", "  repository: nginx", "  tag: 1.25-alpine", "replicaCount: 2"].join("\n");
    expect(round(source)).toBe(source);
  });

  it("reproduces every value of a document it only partly understands", () => {
    const source = "image:\n  repository: nginx\nunknownKey:\n  nested: true\n";
    expect(round(source)).toContain("unknownKey:\n  nested: true");
  });

  it("says so rather than half-importing raw manifests", () => {
    const { warnings } = importValues("apiVersion: apps/v1\nkind: Deployment\n---\nkind: Service\n");
    expect(warnings.join(" ")).toContain("not raw manifests");
  });

  it("refuses a scalar or a list with a sentence, not a stack trace", () => {
    expect(importValues("- a\n- b\n").warnings[0]).toContain("not a YAML mapping");
  });
});
