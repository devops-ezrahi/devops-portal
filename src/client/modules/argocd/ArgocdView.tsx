import { zipSync, strToU8 } from "fflate";
import { Check, FileUp, Pencil, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModuleViewProps } from "../../moduleTypes";
import type { ArgocdTree } from "../../../server/types";
import { log, error as logError } from "../../log";
import { createTree, deleteTree, listTrees, updateTree, type TreeDefaults } from "./api";
import { buildValues, extraValuesError, parseValues } from "./build";
import { checkValues } from "./checks";
import { BY_ID } from "./catalog";
import { deepMerge } from "./values";
import { buildTree } from "./tree";
import { isEmptyTree, newNamespace, newRelease, newTree, toInput, type DraftTree } from "./document";
import { FeatureEditor } from "./components/FeatureEditor";
import { FilePreview } from "./components/FilePreview";
import { ImportDialog } from "./components/ImportDialog";
import { TreeList } from "./components/TreeList";
import type { FeatureState } from "./catalog";
import type { ImportResult } from "./import";
import { toYaml } from "./yaml";

/** The tree the Refresh button (and a page reload) reopens. */
const LAST_OPENED_KEY = "argocd.lastOpened";

/** How long to sit on a change before writing it. One keystroke is not an edit. */
const AUTOSAVE_MS = 800;

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Which layer the form is editing: the release's base, or one namespace's
 * overrides. It is the namespace's *index*, not its name — a namespace is named
 * after it is added, and an unnamed one has to be selectable to be named.
 */
const BASE = -1;

export function ArgocdView({ user, isAdmin, refreshKey, onError }: ModuleViewProps) {
  const [trees, setTrees] = useState<ArgocdTree[]>([]);
  const [defaults, setDefaults] = useState<TreeDefaults | undefined>();
  const [draft, setDraft] = useState<DraftTree>(() => newTree());
  const [releaseId, setReleaseId] = useState("");
  const [layer, setLayer] = useState<number>(BASE);
  const [showAll, setShowAll] = useState(true);
  const [naming, setNaming] = useState(false);
  const [repoOpen, setRepoOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  /** The id the next write should PUT to. A ref, because the write queue reads it after an await. */
  const idRef = useRef("");
  /** The JSON of what is already on the server, so a write that lands back in the same shape is not repeated. */
  const persisted = useRef("");
  /** One write at a time: a create must finish and hand back an id before the next PUT. */
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    log("argocd", "view mounted / refreshed", { isAdmin, refreshKey });
    listTrees()
      .then((result) => {
        log("argocd", `trees loaded: ${result.trees.length}`);
        setTrees(result.trees);
        setDefaults(result.defaults);
        // Reopen whatever was last open, so Refresh lands back where you were —
        // but never over a tree already opened by hand while this was in flight.
        const last = result.trees.find((t) => t.id === localStorage.getItem(LAST_OPENED_KEY));
        if (last && !idRef.current) handleOpen(last);
        else if (!idRef.current) setDraft((prev) => (prev.chart.repoUrl ? prev : newTree(result.defaults)));
      })
      .catch((err: Error) => {
        logError("argocd", "listTrees failed", err);
        onError(err.message);
      });
  }, [refreshKey]);

  // Admins get every tree from the server; the toggle narrows it back
  // client-side, same as every other list in the portal.
  const visibleTrees = useMemo(
    () => (isAdmin && !showAll ? trees.filter((t) => t.createdBy === user.id) : trees),
    [trees, showAll, isAdmin, user.id]
  );
  const files = useMemo(() => buildTree(draft), [draft]);
  const release = draft.releases.find((r) => r.id === releaseId) ?? draft.releases[0];
  const namespace = layer === BASE ? undefined : draft.namespaces[layer];
  const nsEntry = namespace?.releases.find((e) => e.release === release?.id);
  const features = (layer === BASE ? release?.features : nsEntry?.features) ?? {};
  const extraValues = (layer === BASE ? release?.extraValues : nsEntry?.extraValues) ?? "";
  const extraError = extraValuesError(extraValues);
  const scopeLabel = layer === BASE ? "base" : namespace?.name.trim() || "this namespace";
  /**
   * The checks run on the document that is actually deployed for this scope —
   * base alone, or base with the namespace's overrides merged over it — and on
   * the *parsed* form of it, so a raw block and extra values are checked
   * exactly like a value typed into a field.
   */
  const problems = useMemo(() => {
    if (!release) return [];
    const base = buildValues(release.features, release.extraValues);
    const effective = layer === BASE ? base : deepMerge(base, buildValues(features, extraValues));
    const found = checkValues(parseValues(toYaml(effective)) ?? {});
    // Cluster-scoped objects belong to one release in the cluster, so a tree
    // that fans the same release out over several namespaces owns them twice.
    const clusterFeatures = Object.entries(release.features)
      .filter(([id, state]) => state.on && BY_ID[id]?.cluster)
      .map(([id]) => BY_ID[id].name);
    if (clusterFeatures.length && draft.namespaces.length > 1)
      found.push({
        level: "warn",
        text: `${clusterFeatures.join(", ")} are cluster-scoped, and this tree deploys ${release.name || "this release"} into ${draft.namespaces.length} namespaces — every one of them would own the same object.`,
      });
    return found;
  }, [release, features, extraValues, layer, draft.namespaces.length]);

  function handleOpen(tree: ArgocdTree) {
    log("argocd", "opening tree", tree.id);
    localStorage.setItem(LAST_OPENED_KEY, tree.id);
    setDraft(tree);
    setReleaseId(tree.releases[0]?.id ?? "");
    setLayer(BASE);
    // It came from the server, so it is already written — otherwise merely
    // opening one would write it straight back.
    idRef.current = tree.id;
    persisted.current = JSON.stringify(toInput(tree));
    setSaveState("idle");
  }

  function handleNew() {
    log("argocd", "new tree");
    setDraft(newTree(defaults));
    setReleaseId("");
    setLayer(BASE);
    idRef.current = "";
    persisted.current = "";
    setSaveState("idle");
    localStorage.removeItem(LAST_OPENED_KEY);
  }

  /** Write the edited feature map back into whichever layer is on screen. */
  function setFeatures(next: Record<string, FeatureState>) {
    patchScope((current) => ({ ...current, features: next }));
  }
  function setExtra(text: string) {
    patchScope((current) => ({ ...current, extraValues: text }));
  }

  function patchScope(fn: (scope: { features: Record<string, FeatureState>; extraValues?: string }) => {
    features: Record<string, FeatureState>;
    extraValues?: string;
  }) {
    if (!release) return;
    setDraft((prev) => {
      if (layer === BASE) {
        return {
          ...prev,
          releases: prev.releases.map((r) => (r.id === release.id ? { ...r, ...fn(r) } : r)),
        };
      }
      return {
        ...prev,
        namespaces: prev.namespaces.map((ns, i) => {
          if (i !== layer) return ns;
          const existing = ns.releases.find((e) => e.release === release.id);
          // A namespace entry is created the moment something is typed into it,
          // not when the namespace is added — an untouched namespace deploys the
          // base as-is and needs no override file of its own.
          const entry = existing ?? { release: release.id, features: {} };
          const updated = { ...entry, ...fn(entry) };
          return {
            ...ns,
            releases: existing
              ? ns.releases.map((e) => (e.release === release.id ? updated : e))
              : [...ns.releases, updated],
          };
        }),
      };
    });
  }

  function handleImport(result: ImportResult, name: string) {
    log("argocd", "imported values", { warnings: result.warnings.length });
    patchScope(() => ({ features: result.features, extraValues: result.extraValues }));
    // A file that names itself names the release too, but only when there is
    // nothing to overwrite.
    if (layer === BASE && name && release && !release.name.trim())
      setDraft((prev) => ({ ...prev, releases: prev.releases.map((r) => (r.id === release.id ? { ...r, name } : r)) }));
    setImportOpen(false);
  }

  function addRelease() {
    const created = newRelease("");
    setDraft((prev) => ({ ...prev, releases: [...prev.releases, created] }));
    setReleaseId(created.id);
    setLayer(BASE);
  }

  function removeRelease(id: string) {
    setDraft((prev) => ({
      ...prev,
      releases: prev.releases.filter((r) => r.id !== id),
      // A namespace's override of a release that no longer exists would generate
      // a values file nothing reads.
      namespaces: prev.namespaces.map((ns) => ({ ...ns, releases: ns.releases.filter((e) => e.release !== id) })),
    }));
    if (releaseId === id) setReleaseId("");
  }

  function addNamespace() {
    // Selected straight away: a namespace is named after it is added, and the
    // name field only exists on the layer that is open.
    setDraft((prev) => ({ ...prev, namespaces: [...prev.namespaces, newNamespace("")] }));
    setLayer(draft.namespaces.length);
  }

  function renameNamespace(index: number, name: string) {
    setDraft((prev) => ({ ...prev, namespaces: prev.namespaces.map((ns, i) => (i === index ? { ...ns, name } : ns)) }));
  }

  function removeNamespace(index: number) {
    setDraft((prev) => ({ ...prev, namespaces: prev.namespaces.filter((_, i) => i !== index) }));
    // Indexes below the removed one shift up, so anything at or after it would
    // now be pointing at a different namespace.
    setLayer((current) => (current === index || current > index ? BASE : current));
  }

  /**
   * Autosave. There is no Save button — a tree is a document, and the list is
   * where you come back to it. A tree nobody has touched is never written:
   * opening the module must not litter the list with empty trees.
   */
  useEffect(() => {
    const input = toInput(draft);
    const json = JSON.stringify(input);
    if (json === persisted.current) return;
    if (!idRef.current && isEmptyTree(draft)) return;

    const timer = setTimeout(() => {
      queue.current = queue.current.then(() => write(input, json));
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  async function write(input: ReturnType<typeof toInput>, json: string) {
    if (json === persisted.current) return;
    setSaveState("saving");
    try {
      // `id` is read at write time rather than captured: the create that ran
      // just before this one in the queue is what put it there.
      const id = idRef.current;
      const { tree } = id ? await updateTree(id, input) : await createTree(input);
      idRef.current = tree.id;
      localStorage.setItem(LAST_OPENED_KEY, tree.id);
      persisted.current = JSON.stringify(toInput(tree));
      log("argocd", id ? "autosaved" : "created", tree.id);
      // Only the server's own fields are taken back — merging the whole record
      // would stamp on whatever was typed while the request was in flight.
      setDraft((prev) => ({
        ...prev,
        id: tree.id,
        updatedAt: tree.updatedAt,
        name: prev.name.trim() ? prev.name : tree.name,
      }));
      setTrees((prev) => [tree, ...prev.filter((t) => t.id !== tree.id)]);
      setSaveState("saved");
    } catch (err) {
      logError("argocd", "autosave failed", err);
      onError(err instanceof Error ? err.message : "Failed to save");
      setSaveState("error");
    }
  }

  async function handleDelete() {
    if (!draft.id) return;
    const id = draft.id;
    try {
      await deleteTree(id);
      log("argocd", "deleted", id);
      setTrees((prev) => prev.filter((t) => t.id !== id));
      handleNew();
    } catch (err) {
      logError("argocd", "delete failed", err);
      onError(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  function handleDownload() {
    const entries = Object.fromEntries(files.map((f) => [f.path, strToU8(f.text)]));
    const blob = new Blob([zipSync(entries) as unknown as BlobPart], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(draft.name || "gitops-tree").replace(/[^\w.-]+/g, "-")}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <header className="topbar">
        <h1>ArgoCD</h1>
        <div className="ag-topbar-actions">
          <span className={`ag-save-state ${saveState}`} role="status">
            {saveState === "saving" && "Saving…"}
            {saveState === "error" && (
              <>
                <TriangleAlert size={15} aria-hidden="true" /> Not saved
              </>
            )}
          </span>
          {draft.id && (
            <button type="button" className="ghost-button" onClick={() => void handleDelete()}>
              <Trash2 size={18} aria-hidden="true" /> Delete
            </button>
          )}
          <button type="button" className="primary" onClick={handleNew}>
            <Plus size={18} aria-hidden="true" /> New
          </button>
        </div>
      </header>

      <div className="workspace-grid">
        <div className="ticket-column">
          <div className="ticket-list-header">
            <h2>{isAdmin && showAll ? "All Trees" : "My Trees"}</h2>
            {isAdmin && (
              <button className="ghost-button" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "My trees" : "All trees"}
              </button>
            )}
          </div>
          <section className="ticket-list-panel" aria-label="Saved trees">
            <div className="ticket-list">
              <TreeList
                trees={visibleTrees}
                selectedId={draft.id}
                isAdmin={isAdmin}
                onSelect={(id) => {
                  const tree = visibleTrees.find((t) => t.id === id);
                  if (tree) handleOpen(tree);
                }}
              />
            </div>
          </section>
        </div>

        <div className="content-column">
          <section className="detail-panel ag-editor" aria-label="GitOps tree editor">
            <div className="ag-section detail-title-row">
              {naming ? (
                <input
                  className="title-edit-input"
                  aria-label="Tree name"
                  value={draft.name}
                  placeholder="Untitled tree"
                  autoFocus
                  onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
                  onBlur={() => setNaming(false)}
                  onKeyDown={(e) => {
                    // Enter and Escape both just leave the field — every keystroke
                    // is already in the draft, and autosave is what writes it.
                    if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
                  }}
                />
              ) : (
                <h2 className="ag-title">{draft.name.trim() || "Untitled tree"}</h2>
              )}
              <button
                type="button"
                className="icon-button edit-toggle"
                aria-label={naming ? "Done editing the name" : "Rename this tree"}
                onClick={() => setNaming((v) => !v)}
              >
                {naming ? <Check size={16} aria-hidden="true" /> : <Pencil size={16} aria-hidden="true" />}
              </button>
            </div>

            <div className="ag-section">
              <button type="button" className="ghost-button ag-repo-toggle" onClick={() => setRepoOpen((v) => !v)}>
                Repositories · chart {draft.chart.revision} · values {draft.values.revision}
              </button>
              {repoOpen && (
                <div className="ag-repo">
                  <label>
                    <span>Chart repo</span>
                    <input
                      value={draft.chart.repoUrl}
                      onChange={(e) => setDraft((p) => ({ ...p, chart: { ...p.chart, repoUrl: e.target.value } }))}
                    />
                  </label>
                  <label>
                    <span>Chart path</span>
                    <input
                      value={draft.chart.path}
                      onChange={(e) => setDraft((p) => ({ ...p, chart: { ...p.chart, path: e.target.value } }))}
                    />
                  </label>
                  <label>
                    <span>Chart revision</span>
                    <input
                      value={draft.chart.revision}
                      onChange={(e) => setDraft((p) => ({ ...p, chart: { ...p.chart, revision: e.target.value } }))}
                    />
                  </label>
                  <label>
                    <span>Values repo</span>
                    <input
                      value={draft.values.repoUrl}
                      onChange={(e) => setDraft((p) => ({ ...p, values: { ...p.values, repoUrl: e.target.value } }))}
                    />
                  </label>
                  <label>
                    <span>Values revision</span>
                    <input
                      value={draft.values.revision}
                      onChange={(e) => setDraft((p) => ({ ...p, values: { ...p.values, revision: e.target.value } }))}
                    />
                  </label>
                  <label>
                    <span>Values path</span>
                    <input
                      placeholder="(repo root)"
                      value={draft.values.path}
                      onChange={(e) => setDraft((p) => ({ ...p, values: { ...p.values, path: e.target.value } }))}
                    />
                  </label>
                  <label>
                    <span>Root app name</span>
                    <input
                      value={draft.rootAppName}
                      onChange={(e) => setDraft((p) => ({ ...p, rootAppName: e.target.value }))}
                    />
                  </label>
                </div>
              )}
            </div>

            <div className="ag-section">
              <div className="ag-tabs" role="tablist" aria-label="Releases">
                {draft.releases.map((r) => (
                  <button
                    key={r.id}
                    role="tab"
                    aria-selected={r.id === release?.id}
                    className={`ag-tab${r.id === release?.id ? " selected" : ""}`}
                    onClick={() => setReleaseId(r.id)}
                  >
                    {r.name.trim() || "unnamed"}
                  </button>
                ))}
                <button type="button" className="ghost-button ag-add" onClick={addRelease}>
                  <Plus size={15} aria-hidden="true" /> Release
                </button>
              </div>

              {release && (
                <div className="ag-scope-head">
                  <label className="ag-name-field">
                    <span>Release name</span>
                    <input
                      value={release.name}
                      placeholder="api-gateway"
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          releases: prev.releases.map((r) => (r.id === release.id ? { ...r, name: e.target.value } : r)),
                        }))
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Remove this release"
                    onClick={() => removeRelease(release.id)}
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>

            {release && (
              <div className="ag-section">
                <div className="ag-tabs" role="tablist" aria-label="Layers">
                  <button
                    role="tab"
                    aria-selected={layer === BASE}
                    className={`ag-tab${layer === BASE ? " selected" : ""}`}
                    onClick={() => setLayer(BASE)}
                  >
                    Base
                  </button>
                  {draft.namespaces.map((ns, i) => (
                    <span className="ag-tab-group" key={i}>
                      <button
                        role="tab"
                        aria-selected={layer === i}
                        className={`ag-tab${layer === i ? " selected" : ""}`}
                        onClick={() => setLayer(i)}
                      >
                        {ns.name.trim() || "unnamed"}
                      </button>
                      {layer === i && (
                        <>
                          <input
                            aria-label="Namespace name"
                            className="ag-ns-name"
                            value={ns.name}
                            placeholder="shop-web"
                            onChange={(e) => renameNamespace(i, e.target.value)}
                          />
                          <button
                            type="button"
                            className="icon-button"
                            aria-label="Remove this namespace"
                            onClick={() => removeNamespace(i)}
                          >
                            <X size={15} aria-hidden="true" />
                          </button>
                        </>
                      )}
                    </span>
                  ))}
                  <button type="button" className="ghost-button ag-add" onClick={addNamespace}>
                    <Plus size={15} aria-hidden="true" /> Namespace
                  </button>
                </div>

                <div className="ag-scope-actions">
                  <button type="button" className="ghost-button" onClick={() => setImportOpen(true)}>
                    <FileUp size={16} aria-hidden="true" /> Import values
                  </button>
                </div>

                <p className="ag-scope-note">
                  {layer === BASE
                    ? "Environment-agnostic values, shared by every namespace that runs this release."
                    : `Only what differs in ${scopeLabel} — anything identical to base is left out of the file.`}
                </p>

                <FeatureEditor
                  // Remounted per scope, so which categories are open is
                  // decided by what that layer actually holds.
                  key={`${release.id}:${layer}`}
                  features={features}
                  scopeLabel={layer === BASE ? "the base file" : `${scopeLabel}'s override file`}
                  extraValues={extraValues}
                  extraError={extraError}
                  onChange={setFeatures}
                  onExtraChange={setExtra}
                />
              </div>
            )}

            <div className="ag-section">
              {problems.length > 0 && (
                <ul className="ag-problems">
                  {problems.map((p) => (
                    <li key={p.text} className={p.level}>
                      <TriangleAlert size={14} aria-hidden="true" /> {p.text}
                    </li>
                  ))}
                </ul>
              )}
              <FilePreview files={files} onDownload={handleDownload} />
            </div>
          </section>
        </div>
      </div>

      {importOpen && release && (
        <ImportDialog scopeLabel={scopeLabel} onImport={handleImport} onClose={() => setImportOpen(false)} />
      )}
    </>
  );
}
