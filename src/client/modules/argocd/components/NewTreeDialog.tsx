import { FilePlus2, GitBranch, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { isSshUrl, normalizeRepoUrl } from "../../../../server/gitUrl";
import { Help } from "../../../Help";
import { pullValues } from "../api";
import { importTree, type TreeImport } from "../importTree";

/**
 * What "New" opens: start empty, or connect a values repository and read the
 * tree that is already in it.
 *
 * Connecting is the interesting half. `importTree` reverses a whole repo —
 * releases, namespaces, and the chart coordinates, which are recorded in the
 * repo's own `root-applicationSet.yaml`. So the chart fields are not asked for
 * here: a repo that already deploys knows which chart it renders, and asking
 * would only invite a typo into the one field nobody should be retyping.
 *
 * The question is put first, as a step of its own, for the reason the
 * Jenkinsfile builder's own New dialog puts it first: importing is the rarer
 * path and would never be found as a second button in a toolbar.
 */
export function NewTreeDialog({
  onScratch,
  onConnect,
  onClose,
}: {
  onScratch: () => void;
  onConnect: (imported: TreeImport, repoUrl: string, revision: string, path: string) => void;
  onClose: () => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [revision, setRevision] = useState("main");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** Held back once, so an import that drops something says so before it happens. */
  const [pending, setPending] = useState<{ imported: TreeImport; repoUrl: string } | null>(null);

  const rewritten = isSshUrl(repoUrl);

  async function handleConnect() {
    if (pending) {
      onConnect(pending.imported, pending.repoUrl, revision, path);
      return;
    }
    setBusy(true);
    setError("");
    try {
      // Normalised here as well as on blur: pressing Connect straight after
      // pasting is the common case, and a blur handler is not a guarantee.
      // The server normalises too — that is the authoritative one — but what
      // is sent should match what the field says it will send.
      const result = await pullValues(normalizeRepoUrl(repoUrl), revision, path);
      const imported = importTree(result.files);
      // The repo URL is the server's, not the field's: an SSH URL was rewritten
      // before the clone, and the tree should record what actually worked.
      if (imported.warnings.length) setPending({ imported, repoUrl: result.repoUrl });
      else onConnect(imported, result.repoUrl, revision, path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that repository");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal ag-new-modal" role="dialog" aria-modal="true" aria-labelledby="ag-new-title">
        <div className="modal-heading">
          <h2 id="ag-new-title">{connecting ? "Connect a repository" : "New tree"}</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {!connecting ? (
          <div className="ag-new-choices">
            <button type="button" className="ag-new-choice" onClick={onScratch}>
              <FilePlus2 size={20} aria-hidden="true" />
              <strong>Start from scratch</strong>
              <small>An empty tree. Add releases and namespaces yourself.</small>
            </button>
            <button type="button" className="ag-new-choice" onClick={() => setConnecting(true)}>
              <GitBranch size={20} aria-hidden="true" />
              <strong>Connect a repository</strong>
              <small>
                Read an existing values repo — its releases, its namespaces and the chart it renders — and commit
                back to it from here.
              </small>
            </button>
          </div>
        ) : (
          <div className="request-form">
            <div className="field-block">
              <span>
                Repository URL
                <Help label="the repository URL">
                  <p>SSH or https — an SSH URL is rewritten to its https form for you.</p>
                  <p>The portal authenticates with a token rather than a key, so it always clones over https.</p>
                </Help>
              </span>
              <input
                autoFocus
                aria-label="Repository URL"
                value={repoUrl}
                placeholder="git@github.com:org/microservices-values.git"
                onChange={(e) => {
                  setRepoUrl(e.target.value);
                  setPending(null);
                }}
                onBlur={() => setRepoUrl((u) => normalizeRepoUrl(u))}
              />
              {rewritten && (
                <small className="field-hint">
                  SSH URL — this becomes <code>{normalizeRepoUrl(repoUrl)}</code>.
                </small>
              )}
            </div>
            <label>
              <span>Branch</span>
              <input aria-label="Branch" value={revision} placeholder="main" onChange={(e) => setRevision(e.target.value)} />
            </label>
            <div className="field-block">
              <span>
                Subdirectory
                <Help label="the subdirectory">
                  <p>Where the tree sits in that repo.</p>
                  <p>Worth setting: a subdirectory is what lets a removed namespace be removed by a commit too.</p>
                </Help>
              </span>
              <input
                aria-label="Subdirectory"
                value={path}
                placeholder="(repository root)"
                onChange={(e) => setPath(e.target.value)}
              />
            </div>

            {error && (
              <p className="ag-new-error">
                <TriangleAlert size={15} aria-hidden="true" /> {error}
              </p>
            )}

            {pending && (
              <div className="ag-import-warnings">
                <p>
                  Read {pending.imported.releases.length} microservice(s) and {pending.imported.namespaces.length}{" "}
                  namespace(s). {pending.imported.warnings.length} thing(s) did not come across cleanly:
                </p>
                <ul>
                  {pending.imported.warnings.slice(0, 12).map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                  {pending.imported.warnings.length > 12 && <li>…and {pending.imported.warnings.length - 12} more.</li>}
                </ul>
              </div>
            )}

            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={() => setConnecting(false)}>
                Back
              </button>
              <button type="button" className="primary" disabled={!repoUrl.trim() || busy} onClick={() => void handleConnect()}>
                {busy ? "Reading…" : pending ? "Import anyway" : "Connect"}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
