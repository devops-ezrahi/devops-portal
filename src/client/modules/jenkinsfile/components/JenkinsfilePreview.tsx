import { AlertTriangle, Check, Copy, Download, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { highlightGroovy } from "../highlight";
import { log, error as logError } from "../../../log";

type Props = {
  code: string;
  problems: string[];
  /**
   * Every problem in the pipeline, including the stages' own and the ones still
   * held back by the touched gate — a mistake you have not looked at yet is
   * exactly the one worth warning about on the way out.
   */
  problemCount: number;
};

export function JenkinsfilePreview({ code, problems, problemCount }: Props) {
  const [copied, setCopied] = useState(false);
  /** Which action is waiting on the "it has problems" dialog, if any. */
  const [pending, setPending] = useState<null | "Copy" | "Download">(null);
  const html = useMemo(() => highlightGroovy(code), [code]);
  const lines = code.trim() ? code.trim().split("\n").length : 0;

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);

  /**
   * Taking a broken file out of the builder is allowed, but not by accident —
   * so a problem holds the action back until it is confirmed. The portal's own
   * modal rather than `window.confirm`: a browser dialog looks like it came
   * from somewhere else.
   */
  function ask(action: "Copy" | "Download") {
    if (problemCount > 0) setPending(action);
    else if (action === "Copy") handleCopy();
    else handleDownload();
  }

  function handleCopy() {
    navigator.clipboard
      ?.writeText(code)
      .then(() => {
        log("jenkinsfile", "copied Jenkinsfile", { bytes: code.length });
        setCopied(true);
      })
      .catch((err: Error) => logError("jenkinsfile", "clipboard write failed", err));
  }

  function handleDownload() {
    // An object URL rather than a data: URL — the file is arbitrary user text
    // and base64-ing it buys nothing.
    const url = URL.createObjectURL(new Blob([code], { type: "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "Jenkinsfile";
    anchor.click();
    URL.revokeObjectURL(url);
    log("jenkinsfile", "downloaded Jenkinsfile", { bytes: code.length });
  }

  return (
    <div className="jf-preview">
      <div className="jf-preview-head">
        <div className="jf-preview-title">
          <h2>Jenkinsfile</h2>
          <span className="jf-group-count">{lines} line{lines === 1 ? "" : "s"}</span>
        </div>
        <div className="jf-preview-actions">
          <button type="button" className="ghost-button" onClick={() => ask("Copy")}>
            {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className="ghost-button" onClick={() => ask("Download")}>
            <Download size={16} aria-hidden="true" /> Download
          </button>
        </div>
      </div>

      {(problems.length > 0 || problemCount > 0) && (
        <ul className="jf-errors" aria-label="Pipeline problems">
          {problemCount > 0 && (
            <li>
              <AlertTriangle size={14} aria-hidden="true" /> {problemCount} unresolved problem
              {problemCount === 1 ? "" : "s"} — this Jenkinsfile is incomplete and will likely fail in Jenkins.
            </li>
          )}
          {problems.map((message) => (
            <li key={message}>
              <AlertTriangle size={14} aria-hidden="true" /> {message}
            </li>
          ))}
        </ul>
      )}

      <pre className="jf-code">
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>

      {pending && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="jf-broken-title">
            <div className="modal-heading">
              <h2 id="jf-broken-title">
                <AlertTriangle size={18} aria-hidden="true" className="jf-broken-icon" />
                {problemCount} unresolved problem{problemCount === 1 ? "" : "s"}
              </h2>
              <button className="icon-button" aria-label="Close" onClick={() => setPending(null)}>
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            {/* Same padded body and right-aligned footer the import dialog uses. */}
            <div className="jf-new-import">
              <p>
                This Jenkinsfile is incomplete — Jenkins will likely fail the build. The problems are listed
                above, on the stages they belong to.
              </p>
              <div className="jf-import-buttons">
                <button type="button" className="ghost-button" onClick={() => setPending(null)}>
                  Go back
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    setPending(null);
                    if (pending === "Copy") handleCopy();
                    else handleDownload();
                  }}
                >
                  {pending} anyway
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
