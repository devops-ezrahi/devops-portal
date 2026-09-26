import { FileCode2, Package, TriangleAlert, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { Help } from "../../../Help";
import { convertManifests } from "../api";
import { importTree, type TreeImport } from "../importTree";
import type { ArgocdTree } from "../../../../server/types";

type Source = "yaml" | "helm";

const DNS = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const ENV_GROUP = /^[a-z][a-zA-Z0-9_]*=[a-z0-9-]+(,[a-z0-9-]+)*$/;

/** Every `metadata.namespace` in a dump, in order — each becomes its own folder in the tree. */
const namespacesIn = (text: string) => [
  ...new Set([...text.matchAll(/^\s+namespace:\s*["']?([a-z0-9][-a-z0-9]*)/gm)].map((m) => m[1])),
];

async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Plain Kubernetes YAML, or a packaged Helm chart, converted into this tree.
 *
 * The conversion is `convert_to_universal_chart.py` from the tree's own chart
 * repo, run on the server; what comes back is a values tree, read with
 * `importTree` exactly like a pull. YAML may be as dirty as `kubectl get -o
 * yaml` makes it: the server splits it into microservices and strips runtime
 * metadata with the chart repo's `namespace_importer.py` first. Like the
 * converter, each namespace is a folder: a document lands in its own
 * `metadata.namespace`, and the default namespace takes the rest — which for a
 * Helm chart is everything it renders, however many microservices that is.
 */
export function ConvertDialog({
  chart,
  namespace: initialNamespace,
  onConvert,
  onClose,
}: {
  chart: ArgocdTree["chart"];
  namespace: string;
  onConvert: (imported: TreeImport, reportWarnings: string[]) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<Source>("yaml");
  const [namespace, setNamespace] = useState(initialNamespace);
  const [nsTyped, setNsTyped] = useState(false);
  const [yaml, setYaml] = useState("");
  const [chartFile, setChartFile] = useState<File | null>(null);
  const [values, setValues] = useState("");
  const [envGroups, setEnvGroups] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const yamlInput = useRef<HTMLInputElement>(null);
  const chartInput = useRef<HTMLInputElement>(null);

  const bad = DNS.test(namespace) ? undefined : namespace;
  const found = source === "yaml" ? namespacesIn(yaml) : [];
  const groups = envGroups.split(";").map((g) => g.replace(/\s+/g, "")).filter(Boolean);
  const badGroup = groups.find((g) => !ENV_GROUP.test(g));
  const ready = !!chart.repoUrl.trim() && (source === "yaml" ? !!yaml.trim() : !!chartFile) && bad === undefined && !badGroup;

  function changeYaml(text: string) {
    setYaml(text);
    const ns = namespacesIn(text)[0];
    if (ns && !nsTyped) setNamespace(ns);
  }

  async function addYaml(files: FileList | null) {
    const texts = await Promise.all([...(files ?? [])].map((f) => f.text()));
    changeYaml([yaml, ...texts].filter((t) => t.trim()).join("\n---\n"));
  }

  async function handleConvert() {
    setBusy(true);
    setError("");
    try {
      const result = await convertManifests({
        chartRepoUrl: chart.repoUrl,
        chartRevision: chart.revision,
        namespace,
        ...(groups.length ? { envGroups: groups } : {}),
        ...(source === "yaml"
          ? { yaml }
          : { helm: { archive: await base64Of(chartFile!), values: values || undefined } }),
      });
      onConvert(importTree(result.files), result.warnings);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The conversion failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal ag-import-modal" role="dialog" aria-modal="true" aria-labelledby="ag-convert-title">
        <div className="modal-heading">
          <h2 id="ag-convert-title">Convert to the universal chart</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="request-form">
          <div className="jf-segmented" role="radiogroup" aria-label="What to convert">
            <button type="button" role="radio" aria-checked={source === "yaml"} className={source === "yaml" ? "active" : ""} onClick={() => setSource("yaml")}>
              <FileCode2 size={15} aria-hidden="true" /> Kubernetes YAML
            </button>
            <button type="button" role="radio" aria-checked={source === "helm"} className={source === "helm" ? "active" : ""} onClick={() => setSource("helm")}>
              <Package size={15} aria-hidden="true" /> Helm chart
            </button>
          </div>

          <div className="field-block">
            <span>
              Default namespace
              <Help label="the default namespace">
                <p>
                  A namespace is a folder in the tree, <code>&lt;ns&gt;/</code>, the same as the converter's input folders. Each manifest lands
                  in the namespace its own <code>metadata.namespace</code> names; this one takes every manifest that names none.
                </p>
                <p>
                  A Helm chart renders without namespaces, so all of it lands here. An existing namespace gets the microservices added; a new
                  name adds one.
                </p>
              </Help>
            </span>
            <input aria-label="Default namespace" value={namespace} placeholder="shop-prod" onChange={(e) => {
                setNsTyped(true);
                setNamespace(e.target.value.trim());
              }}
            />
            {found.length > 0 && (
              <p className="field-hint">
                Found in the YAML: {found.join(", ")}
              </p>
            )}
          </div>

          <div className="field-block">
            <span>
              Env groups
              <Help label="env groups">
                <p>
                  Optional. <code>color=black,yellow</code> puts <code>ms1-yellow</code> and <code>ms1-black</code> into one shared{" "}
                  <code>base/ms1.yaml</code>, templated with <code>{"{{ .Values.color }}"}</code>, and deploys each from its own folder:{" "}
                  <code>&lt;ns&gt;/yellow/</code>, <code>&lt;ns&gt;/black/</code>. Separate several groups with <code>;</code>.
                </p>
              </Help>
            </span>
            <input aria-label="Env groups" value={envGroups} placeholder="color=black,yellow" onChange={(e) => setEnvGroups(e.target.value)} />
            {badGroup && (
              <p className="ag-new-error">
                <TriangleAlert size={15} aria-hidden="true" /> “{badGroup}” is not a group — write key=token,token.
              </p>
            )}
          </div>

          {source === "yaml" ? (
            <div className="field-block">
              <span>
                Manifests
                <Help label="the manifests">
                  <p>
                    Paste or add any Kubernetes YAML — straight out of <code>kubectl get -o yaml</code> is fine. Status, managedFields,
                    uids and the rest of the runtime metadata are stripped.
                  </p>
                  <p>
                    It is split into microservices the way the chart repo's namespace importer does: by <code>app.kubernetes.io/part-of</code>,
                    then <code>app</code>, then the workload name. What several of them use goes to <code>shared</code>.
                  </p>
                </Help>
              </span>
              <textarea
                className="ag-textarea"
                aria-label="Kubernetes YAML"
                rows={10}
                spellCheck={false}
                value={yaml}
                placeholder={"apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: checkout\n  namespace: shop-prod\n…"}
                onChange={(e) => changeYaml(e.target.value)}
              />
              <input ref={yamlInput} type="file" accept=".yaml,.yml" multiple hidden onChange={(e) => void addYaml(e.target.files)} />
              <button type="button" className="ghost-button" onClick={() => yamlInput.current?.click()}>
                <Upload size={15} aria-hidden="true" /> Add YAML files
              </button>
            </div>
          ) : (
            <>
              <div className="field-block">
                <span>
                  Chart
                  <Help label="the chart">
                    <p>
                      The .tgz that <code>helm package</code> writes, subcharts included. It is rendered with <code>helm template</code> under
                      its own <code>Chart.yaml</code> name, then split like pasted YAML — every workload it renders becomes a microservice.
                    </p>
                  </Help>
                </span>
                <input ref={chartInput} type="file" accept=".tgz,.tar.gz" hidden onChange={(e) => setChartFile(e.target.files?.[0] ?? null)} />
                <button type="button" className="ghost-button" onClick={() => chartInput.current?.click()}>
                  <Upload size={15} aria-hidden="true" /> {chartFile ? chartFile.name : "Choose a chart"}
                </button>
              </div>
              <label>
                <span>Values (optional)</span>
                <textarea
                  className="ag-textarea"
                  aria-label="Helm values"
                  rows={4}
                  spellCheck={false}
                  value={values}
                  placeholder={"replicaCount: 2\nimage:\n  tag: 1.4.2"}
                  onChange={(e) => setValues(e.target.value)}
                />
              </label>
            </>
          )}

          {bad && (
            <p className="ag-new-error">
              <TriangleAlert size={15} aria-hidden="true" /> “{bad || "(empty)"}” is not a Kubernetes name — lowercase letters, digits and dashes.
            </p>
          )}
          {!chart.repoUrl.trim() && (
            <p className="ag-new-error">
              <TriangleAlert size={15} aria-hidden="true" /> Set this tree's chart repository first — the converter comes from there.
            </p>
          )}
          {error && (
            <p className="ag-new-error">
              <TriangleAlert size={15} aria-hidden="true" /> {error}
            </p>
          )}

          <div className="modal-actions">
            <button type="button" className="ghost-button" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="primary" disabled={!ready || busy} onClick={() => void handleConvert()}>
              {busy ? "Converting…" : "Convert"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
