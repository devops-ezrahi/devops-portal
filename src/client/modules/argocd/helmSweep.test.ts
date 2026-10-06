import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildValues } from "./build";
import { mergeConverted, newTree } from "./document";
import { importValues } from "./import";
import { importTree } from "./importTree";
import { buildTree } from "./tree";
import { toYaml } from "./yaml";

// Defects a 57-chart sweep (Bitnami, ingress-nginx, cert-manager, mlflow, …) found in
// the round trip a converted tree takes through the builder: import, rebuild, commit.
const roundTrip = (text: string) => {
  const { features, extraValues } = importValues(text);
  return parse(toYaml(buildValues(features, extraValues))) as Record<string, any>;
};

describe("a converted values file survives the builder", () => {
  it("keeps one volume mounted at several subPaths as separate mounts (Bitnami's empty-dir)", () => {
    const text = `volumeMounts:
  certificate:
    mountPath: /certs
  empty-dir:app-conf-dir:
    mountPath: /opt/app/conf
    name: empty-dir
    subPath: app-conf-dir
  empty-dir:tmp-dir:
    mountPath: /tmp
    name: empty-dir
    subPath: tmp-dir
`;
    expect(roundTrip(text).volumeMounts).toEqual(parse(text).volumeMounts);
  });

  it("does not split a Secret's file into keys at each `=`", () => {
    const text = `secrets:
  exporter:
    stringData:
      config.yml: |-
        host: localhost
        # java -Dlevel=trace -jar exporter.jar
      PLAIN: x
`;
    expect(Object.keys(roundTrip(text).secrets.exporter.stringData).sort()).toEqual(["PLAIN", "config.yml"]);
    expect(roundTrip(text).secrets.exporter.stringData["config.yml"]).toContain("-Dlevel=trace");
  });

  it("writes no init-container order for an override that only re-tags images", () => {
    const override = `initContainers:
  upgrade-db:
    image: reg/mlflow:2
  wait-for-database:
    image: reg/wait:2
`;
    expect(roundTrip(override).initContainerOrder).toBeUndefined();
  });

  it("keeps an init-container order the file states, and one that is not sorted", () => {
    const base = `initContainers:
  wait-for-database: { image: a }
  upgrade-db: { image: b }
initContainerOrder: [wait-for-database, upgrade-db]
`;
    expect(roundTrip(base).initContainerOrder).toEqual(["wait-for-database", "upgrade-db"]);
  });

  it("keeps a Job's fieldRef env without inventing value: \"\"", () => {
    const text = `jobs:
  admission-create:
    env:
      POD_NAMESPACE:
        valueFrom:
          fieldRef:
            fieldPath: metadata.namespace
      PLAIN:
        value: x
`;
    expect(roundTrip(text).jobs["admission-create"].env).toEqual(parse(text).jobs["admission-create"].env);
  });

  it("commits an untouched convert as the converter wrote it", () => {
    const files = [
      { path: "base/web.yaml", text: "# written by the converter\nimage:\n  repository: 'reg/web'\n" },
      { path: "app/defaults.yaml", text: "# defaults\n{}\n" },
      { path: "app/values/web.yaml", text: "image:\n  tag: '1.0'\n" },
    ];
    const { tree } = mergeConverted(newTree(), importTree(files));
    const built = buildTree({ ...tree, name: "t" });
    for (const f of files) expect(built.find((b) => b.path === f.path)?.text).toBe(f.text);
  });
});
