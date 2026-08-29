import { FilePlus2, FileUp, TriangleAlert, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { parseJenkinsfile } from "../parse";
import type { DraftPipeline } from "../pipeline";

/**
 * What "New" opens: start empty, or bring an existing Jenkinsfile in.
 *
 * The choice is a step of its own rather than a second button in the topbar —
 * importing is the rarer of the two and does not deserve permanent furniture,
 * and putting the question first is what makes the option discoverable at all.
 */
export function NewPipelineDialog({
  onScratch,
  onImport,
  onClose,
}: {
  onScratch: () => void;
  onImport: (pipeline: DraftPipeline, warnings: string[]) => void;
  onClose: () => void;
}) {
  const [importing, setImporting] = useState(false);
  const [text, setText] = useState("");
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [filename, setFilename] = useState("");
  const file = useRef<HTMLInputElement>(null);

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
          <h2 id="jf-new-title">{importing ? "Import a Jenkinsfile" : "New pipeline"}</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {!importing ? (
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
            <textarea
              id="jf-import-text"
              className="jf-import-text"
              spellCheck={false}
              placeholder={"@Library('jenkins-k8s-shared-library') _\n\ngenStage(\n    title: 'Build',\n    image: 'python311',\n    commands: ['npm ci']\n)"}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setWarnings(null);
              }}
            />

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
