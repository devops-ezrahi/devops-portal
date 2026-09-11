import { FilePlus2, FileUp, GitBranch, TriangleAlert, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { isSshUrl, normalizeRepoUrl } from "../../../../server/gitUrl";
import type { JenkinsfilePipeline } from "../../../../server/types";
import { pullJenkinsfile } from "../api";
import { highlightGroovy } from "../highlight";
import { parseJenkinsfile } from "../parse";
import type { DraftPipeline } from "../pipeline";

type Repo = NonNullable<JenkinsfilePipeline["repo"]>;

/**
 * What "New" opens: start empty, bring an existing Jenkinsfile in, or connect
 * the repository that holds one.
 *
 * The choice is a step of its own rather than three buttons in the topbar —
 * two of the three are rare and do not deserve permanent furniture, and putting
 * the question first is what makes them discoverable at all.
 *
 * Connecting and pasting end in the same place: `parseJenkinsfile`, the same
 * warnings list, and the same "import anyway" gate. The only difference is
 * where the text came from, which is why the repo form sets `text` and then
 * falls through to the import screen rather than having a second one.
 */
export function NewPipelineDialog({
  onScratch,
  onImport,
  onClose,
  gitEnabled,
}: {
  onScratch: () => void;
  onImport: (pipeline: DraftPipeline, warnings: string[], repo?: Repo) => void;
  onClose: () => void;
  gitEnabled: boolean;
}) {
  const [importing, setImporting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [text, setText] = useState("");
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [filename, setFilename] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const shadow = useRef<HTMLPreElement>(null);

  const [repoUrl, setRepoUrl] = useState("");
  const [revision, setRevision] = useState("main");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** Held back once, so an import that drops something says so before it happens. */
  const [pending, setPending] = useState<{ pipeline: DraftPipeline; warnings: string[]; repo: Repo } | null>(null);

  const rewritten = isSshUrl(repoUrl);

  async function handleConnect() {
    if (pending) {
      onImport(pending.pipeline, pending.warnings, pending.repo);
      return;
    }
    setBusy(true);
    setError("");
    try {
      // Normalised here as well as on blur: pressing Connect straight after
      // pasting is the common case, and a blur handler is not a guarantee. The
      // server normalises too — that is the authoritative one — but what is
      // sent should match what the field says it will send.
      const result = await pullJenkinsfile(normalizeRepoUrl(repoUrl), revision, path.trim());
      const parsed = parseJenkinsfile(result.text);
      // The repo is the server's answer, not the field's: an SSH URL was
      // rewritten before the clone, and the path was very likely found rather
      // than typed — the pipeline must commit back to the file it read.
      const repo: Repo = { repoUrl: result.repoUrl, revision: result.revision, path: result.path };
      if (parsed.warnings.length) setPending({ pipeline: parsed.pipeline, warnings: parsed.warnings, repo });
      else onImport(parsed.pipeline, parsed.warnings, repo);
    } catch (err) {
      // "Several Jenkinsfiles — type the path of the one you want below" comes
      // through here: the server answers 404 with the sentence, and the path
      // field it names is already on screen.
      setError(err instanceof Error ? err.message : "Could not read that repository");
    } finally {
      setBusy(false);
    }
  }

  // Parsed on demand rather than per keystroke: pasting a long file would
  // otherwise re-parse it on every character of the paste.
  function handleImport() {
    const result = parseJenkinsfile(text);
    if (result.warnings.length && !warnings) {
      // Shown once first — importing anyway is a click away, but silently
      // dropping a stage the file did contain is not something to do quietly.
      setWarnings(result.warnings);
      return;
    }
    onImport(result.pipeline, result.warnings);
  }

  async function handleFile(chosen: File | undefined) {
    if (!chosen) return;
    setFilename(chosen.name);
    setWarnings(null);
    setText(await chosen.text());
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal jf-new-modal" role="dialog" aria-modal="true" aria-labelledby="jf-new-title">
        <div className="modal-heading">
          <h2 id="jf-new-title">
            {connecting ? "Connect a repository" : importing ? "Import a Jenkinsfile" : "New pipeline"}
          </h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {connecting ? (
          <div className="request-form">
            <label>
              <span>Repository URL</span>
              <input
                autoFocus
                value={repoUrl}
                placeholder="git@github.com:org/checkout-service.git"
                onChange={(e) => {
                  setRepoUrl(e.target.value);
                  setPending(null);
                }}
                onBlur={() => setRepoUrl((u) => normalizeRepoUrl(u))}
              />
              {rewritten ? (
                <small className="field-hint">
                  SSH URL — this becomes <code>{normalizeRepoUrl(repoUrl)}</code>. The portal authenticates with a
                  token rather than a key, so it clones over https.
                </small>
              ) : (
                <small className="field-hint">SSH or https; an SSH URL is rewritten for you.</small>
              )}
            </label>
            <label>
              <span>Branch</span>
              <input value={revision} placeholder="main" onChange={(e) => setRevision(e.target.value)} />
            </label>
            <label>
              <span>Path to the Jenkinsfile</span>
              <input
                value={path}
                placeholder="(find it)"
                onChange={(e) => {
                  setPath(e.target.value);
                  setPending(null);
                }}
              />
              <small className="field-hint">
                Leave it empty and the repository is searched. Fill it in when the answer is "several" — or when
                the file is called something else.
              </small>
            </label>

            {error && (
              <p className="jf-new-error">
                <TriangleAlert size={15} aria-hidden="true" /> {error}
              </p>
            )}

            {pending && (
              <div className="jf-import-warnings" role="status">
                <p>
                  <TriangleAlert size={15} aria-hidden="true" /> Read <code>{pending.repo.path}</code>, but some of
                  it could not be understood. Import anyway and the rest comes in:
                </p>
                <ul>
                  {pending.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="jf-import-buttons">
              <button type="button" className="ghost-button" onClick={() => setConnecting(false)}>
                Back
              </button>
              <button
                type="button"
                className="primary"
                disabled={!repoUrl.trim() || busy}
                onClick={() => void handleConnect()}
              >
                {busy ? "Reading…" : pending ? "Import anyway" : "Connect"}
              </button>
            </div>
          </div>
        ) : !importing ? (
          <div className="jf-new-choices">
            <button type="button" className="jf-new-choice" onClick={onScratch}>
              <FilePlus2 size={18} aria-hidden="true" />
              <span className="jf-new-choice-name">Start from scratch</span>
              <span className="jf-new-choice-hint">An empty pipeline. Add stages from the palette.</span>
            </button>
            <button type="button" className="jf-new-choice" onClick={() => setImporting(true)}>
              <FileUp size={18} aria-hidden="true" />
              <span className="jf-new-choice-name">Import an existing Jenkinsfile</span>
              <span className="jf-new-choice-hint">
                Paste it or pick the file — its steps, arguments and parameters become cards.
              </span>
            </button>
            <button
              type="button"
              className="jf-new-choice"
              disabled={!gitEnabled}
              title={gitEnabled ? undefined : "No git credential is configured for this portal (GIT_URL / GIT_TOKEN)."}
              onClick={() => setConnecting(true)}
            >
              <GitBranch size={18} aria-hidden="true" />
              <span className="jf-new-choice-name">Connect a repository</span>
              <span className="jf-new-choice-hint">
                Read the Jenkinsfile that is already in a repo — and commit back to it from here.
              </span>
            </button>
          </div>
        ) : (
          <div className="jf-new-import">
            <div className="jf-import-actions">
              <button type="button" className="ghost-button" onClick={() => file.current?.click()}>
                <Upload size={15} aria-hidden="true" /> Choose a file
              </button>
              {filename && <span className="field-hint">{filename}</span>}
              <input
                ref={file}
                type="file"
                // Jenkinsfiles usually have no extension at all, so nothing is
                // filtered out — the accept list is a hint, not a gate.
                accept=".groovy,.jenkinsfile,text/plain"
                hidden
                onChange={(e) => void handleFile(e.target.files?.[0])}
              />
            </div>

            <label htmlFor="jf-import-text">Or paste it here</label>
            {/* A textarea cannot colour its own text, so the highlighted copy sits
                behind it and the textarea's own text is transparent — the two share
                every metric that decides where a character lands, and the scroll
                position is copied over on each scroll. */}
            <div className="jf-import-editor">
              <pre className="jf-import-text jf-import-shadow" aria-hidden="true" ref={shadow}>
                {/* The trailing newline keeps a final empty line scrollable in step
                    with the textarea, which always reserves one. */}
                <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightGroovy(text) + "\n" }} />
              </pre>
              <textarea
                id="jf-import-text"
                className="jf-import-text"
                spellCheck={false}
                placeholder={"@Library('jenkins-k8s-shared-library') _\n\ngenStage(\n    title: 'Build',\n    image: 'python311',\n    commands: ['npm ci']\n)"}
                value={text}
                onScroll={(e) => {
                  if (!shadow.current) return;
                  shadow.current.scrollTop = e.currentTarget.scrollTop;
                  shadow.current.scrollLeft = e.currentTarget.scrollLeft;
                }}
                onChange={(e) => {
                  setText(e.target.value);
                  setWarnings(null);
                }}
              />
            </div>

            {warnings && warnings.length > 0 && (
              <div className="jf-import-warnings" role="status">
                <p>
                  <TriangleAlert size={15} aria-hidden="true" /> Some of the file could not be read. Import anyway
                  and the rest comes in:
                </p>
                <ul>
                  {warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="jf-import-buttons">
              <button type="button" className="ghost-button" onClick={() => setImporting(false)}>
                Back
              </button>
              <button type="button" className="primary" disabled={!text.trim()} onClick={handleImport}>
                {warnings ? "Import anyway" : "Import"}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
