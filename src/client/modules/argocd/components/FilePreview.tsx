import { Copy, Download } from "lucide-react";
import { useState } from "react";
import type { GeneratedFile } from "../tree";

/**
 * The generated tree, one file at a time. The switcher is the file list, so
 * what a change did to which file is visible without downloading anything.
 */
export function FilePreview({
  files,
  onDownload,
}: {
  files: GeneratedFile[];
  onDownload: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const file = files[Math.min(selected, files.length - 1)];
  const [copied, setCopied] = useState(false);

  if (!file) return <p className="empty-state">Add a release to see the files this tree generates.</p>;

  return (
    <div className="ag-preview">
      <div className="ag-preview-head">
        <h3>Generated files</h3>
        <div className="ag-preview-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              void navigator.clipboard.writeText(file.text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Copy size={16} aria-hidden="true" /> {copied ? "Copied" : "Copy file"}
          </button>
          <button type="button" className="ghost-button" onClick={onDownload}>
            <Download size={16} aria-hidden="true" /> Download tree
          </button>
        </div>
      </div>
      <div className="ag-preview-body">
        <ul className="ag-file-list">
          {files.map((f, i) => (
            <li key={f.path}>
              <button
                type="button"
                className={`ag-file${i === selected ? " selected" : ""}`}
                onClick={() => setSelected(i)}
              >
                <span className="ag-file-path">{f.path}</span>
                <span className="ag-file-note">{f.note}</span>
              </button>
            </li>
          ))}
        </ul>
        <pre className="ag-file-body">
          <code>{file.text}</code>
        </pre>
      </div>
    </div>
  );
}
