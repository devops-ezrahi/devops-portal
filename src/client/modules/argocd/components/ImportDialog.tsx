import { TriangleAlert, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { importValues, releaseNameFrom } from "../import";
import type { ImportResult } from "../import";

/**
 * Paste an existing `values.yaml` into the layer on screen.
 *
 * Warnings are shown once before anything is replaced — importing anyway is one
 * more click, but a key silently landing somewhere other than where the file
 * put it is not something to do quietly.
 */
export function ImportDialog({
  scopeLabel,
  onImport,
  onClose,
}: {
  scopeLabel: string;
  onImport: (result: ImportResult, name: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [filename, setFilename] = useState("");
  const file = useRef<HTMLInputElement>(null);

  // Parsed on demand rather than per keystroke: pasting a long file would
  // otherwise re-parse it on every character of the paste.
  function handleImport() {
    const result = importValues(text);
    if (result.warnings.length && !warnings) {
      setWarnings(result.warnings);
      return;
    }
    onImport(result, releaseNameFrom(text));
  }

  async function handleFile(chosen: File | undefined) {
    if (!chosen) return;
    setFilename(chosen.name);
    setWarnings(null);
    setText(await chosen.text());
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal ag-import-modal" role="dialog" aria-modal="true" aria-labelledby="ag-import-title">
        <div className="modal-heading">
          <h2 id="ag-import-title">Import values into {scopeLabel}</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <p className="ag-hint">
          A chart values.yaml — not raw Kubernetes manifests. Anything the form cannot show is kept as extra values.
        </p>

        <textarea
          className="ag-textarea ag-import-text"
          aria-label="values.yaml"
          rows={14}
          spellCheck={false}
          value={text}
          placeholder={"nameOverride: checkout-api\nimage:\n  repository: registry/checkout\n  tag: \"1.4.2\""}
          onChange={(e) => {
            setText(e.target.value);
            setWarnings(null);
          }}
        />

        {warnings && warnings.length > 0 && (
          <div className="ag-import-warnings">
            <p>
              <TriangleAlert size={15} aria-hidden="true" /> Read, with changes:
            </p>
            <ul>
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            <p className="ag-hint">Import again to go ahead.</p>
          </div>
        )}

        <div className="modal-actions">
          <input
            ref={file}
            type="file"
            accept=".yaml,.yml,text/yaml"
            hidden
            onChange={(e) => void handleFile(e.target.files?.[0])}
          />
          <button type="button" className="ghost-button" onClick={() => file.current?.click()}>
            <Upload size={16} aria-hidden="true" /> {filename || "Choose a file"}
          </button>
          <button type="button" className="primary" disabled={!text.trim()} onClick={handleImport}>
            {warnings ? "Import anyway" : "Import"}
          </button>
        </div>
      </section>
    </div>
  );
}
