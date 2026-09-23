import { FileCode2, Package, TriangleAlert, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { Help } from "../../../Help";
import { convertManifests } from "../api";
import { importTree, type TreeImport } from "../importTree";
import type { ArgocdTree } from "../../../../server/types";

type Source = "yaml" | "helm";
type Manifest = { name: string; text: string };

/** A file name as a Kubernetes name: `Stalker Deployment.yaml` -> `stalker-deployment`. */
const k8sName = (file: string) =>
  file
    .replace(/\.(ya?ml|tgz|tar\.gz)$/i, "")
    .replace(/-\d+(\.\d+)*(-[\w.]+)?$/, "") // a chart's `-1.2.3` version suffix
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

const DNS = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

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
 * `importTree` exactly like a pull. One file is one microservice — that is the
 * converter's own input rule — and everything lands in one namespace.
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
  const [manifests, setManifests] = useState<Manifest[]>([]);
  const [chartFile, setChartFile] = useState<File | null>(null);
  const [releaseName, setReleaseName] = useState("");
  const [values, setValues] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const yamlInput = useRef<HTMLInputElement>(null);
  const chartInput = useRef<HTMLInputElement>(null);

  const names = source === "yaml" ? manifests.map((m) => m.name) : [releaseName];
  const bad = [namespace, ...names].find((n) => !DNS.test(n));
  const ready = !!chart.repoUrl.trim() && (source === "yaml" ? manifests.length > 0 : !!chartFile) && !bad;

  async function addYaml(files: FileList | null) {
    const added = await Promise.all([...(files ?? [])].map(async (f) => ({ name: k8sName(f.name), text: await f.text() })));
    setManifests((prev) => [...prev.filter((m) => !added.some((a) => a.name === m.name)), ...added]);
  }

  async function handleConvert() {
    setBusy(true);
    setError("");
    try {
      const result = await convertManifests({
        chartRepoUrl: chart.repoUrl,
        chartRevision: chart.revision,
        namespace,
        ...(source === "yaml"
          ? { manifests }
          : { helm: { name: releaseName, archive: await base64Of(chartFile!), values: values || undefined } }),
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
              Namespace
              <Help label="the namespace">
                <p>Where these microservices run. An existing namespace of this tree gets them added; a new name adds a namespace.</p>
              </Help>
            </span>
            <input aria-label="Namespace" value={namespace} placeholder="shop-prod" onChange={(e) => setNamespace(e.target.value.trim())} />
          </div>

          {source === "yaml" ? (
            <div className="field-block">
              <span>
                Manifests
                <Help label="the manifests">
                  <p>One file per microservice — its Deployment, Service, ConfigMaps and the rest, as kubectl would apply them.</p>
                  <p>The file name becomes the microservice name; edit it below.</p>
                </Help>
              </span>
              <input ref={yamlInput} type="file" accept=".yaml,.yml" multiple hidden onChange={(e) => void addYaml(e.target.files)} />
              <button type="button" className="ghost-button" onClick={() => yamlInput.current?.click()}>
                <Upload size={15} aria-hidden="true" /> Choose YAML files
              </button>
              {manifests.map((m, i) => (
                <div className="ag-row" key={i}>
                  <input
                    aria-label="Microservice name"
                    value={m.name}
                    onChange={(e) => setManifests((prev) => prev.map((x, n) => (n === i ? { ...x, name: e.target.value } : x)))}
                  />
                  <button type="button" className="icon-button" aria-label={`Remove ${m.name}`} onClick={() => setManifests((prev) => prev.filter((_, n) => n !== i))}>
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="field-block">
                <span>
                  Chart
                  <Help label="the chart">
                    <p>The .tgz that <code>helm package</code> writes, subcharts included. It is rendered with <code>helm template</code>, then converted.</p>
                  </Help>
                </span>
                <input
                  ref={chartInput}
                  type="file"
                  accept=".tgz,.tar.gz"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    setChartFile(f);
                    if (f && !releaseName) setReleaseName(k8sName(f.name));
                  }}
                />
                <button type="button" className="ghost-button" onClick={() => chartInput.current?.click()}>
                  <Upload size={15} aria-hidden="true" /> {chartFile ? chartFile.name : "Choose a chart"}
                </button>
              </div>
              <label>
                <span>Microservice name</span>
                <input aria-label="Microservice name" value={releaseName} placeholder="checkout" onChange={(e) => setReleaseName(e.target.value.trim())} />
              </label>
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

          {bad !== undefined && (namespace || names.some(Boolean)) && (
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
