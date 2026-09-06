import { ChevronDown, ChevronRight, Copy, Download, FileText, Folder, FolderOpen } from "lucide-react";
import { useMemo, useState } from "react";
import type { GeneratedFile } from "../tree";

/**
 * The generated tree, as a tree. The switcher is the directory listing the
 * values repo will hold, so what a change did to which file — and which folder
 * that file lives in — is visible without downloading anything.
 */
type Node = { name: string; path: string; children: Node[]; file?: GeneratedFile };

/** Paths into a folder tree, keeping generation order (defaults, base, then each namespace). */
function toTree(files: GeneratedFile[]): Node[] {
  const roots: Node[] = [];
  for (const file of files) {
    const parts = file.path.split("/");
    let level = roots;
    let prefix = "";
    parts.forEach((name, i) => {
      prefix = prefix ? `${prefix}/${name}` : name;
      const leaf = i === parts.length - 1;
      let node = level.find((n) => n.name === name && !!n.file === leaf);
      if (!node) {
        node = { name, path: prefix, children: [], ...(leaf ? { file } : {}) };
        level.push(node);
      }
      level = node.children;
    });
  }
  return roots;
}

export function FilePreview({ files, onDownload }: { files: GeneratedFile[]; onDownload: () => void }) {
  const [selected, setSelected] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const tree = useMemo(() => toTree(files), [files]);

  // The selection survives an edit that renames a file out from under it by
  // falling back to the first one, rather than blanking the panel.
  const file = files.find((f) => f.path === selected) ?? files[0];

  if (!file) return <p className="empty-state">Add a release to see the files this tree generates.</p>;

  function toggle(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }

  function render(nodes: Node[], depth: number) {
    return nodes.map((node) => {
      const pad = { paddingLeft: `${8 + depth * 14}px` };
      if (node.file) {
        return (
          <li key={node.path}>
            <button
              type="button"
              className={`ag-file${node.path === file!.path ? " selected" : ""}`}
              // The row shows the basename; the full path is what names it, so
              // a screen reader (and a test) still gets the whole thing.
              aria-label={node.path}
              title={node.path}
              style={pad}
              onClick={() => setSelected(node.path)}
            >
              <span className="ag-file-gutter" aria-hidden="true" />
              <FileText size={13} aria-hidden="true" />
              <span className="ag-file-name">{node.name}</span>
            </button>
          </li>
        );
      }
      const open = !collapsed.has(node.path);
      return (
        <li key={node.path}>
          <button type="button" className="ag-folder" style={pad} aria-expanded={open} onClick={() => toggle(node.path)}>
            {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
            {open ? <FolderOpen size={13} aria-hidden="true" /> : <Folder size={13} aria-hidden="true" />}
            <span className="ag-folder-name">{node.name}</span>
          </button>
          {open && <ul className="ag-file-children">{render(node.children, depth + 1)}</ul>}
        </li>
      );
    });
  }

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
        <ul className="ag-file-list" aria-label="Generated files">
          {render(tree, 0)}
        </ul>
        <div className="ag-file-pane">
          {/* The path and what the file is for, once, above the file — rather
              than repeated down a column that has no room for it. */}
          <p className="ag-file-path">
            {file.path} <span className="ag-file-note">{file.note}</span>
          </p>
          <pre className="ag-file-body">
            <code>{file.text}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}
