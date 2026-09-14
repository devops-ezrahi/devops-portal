import { ChevronDown, ChevronRight, Copy, Download, FileText, Folder, FolderOpen } from "lucide-react";
import { useMemo, useState } from "react";
import { diffLines, diffTree, type FileStatus, type TreeEntry } from "../diff";
import type { RepoFile } from "../api";
import type { GeneratedFile } from "../tree";

/**
 * The generated tree, as a tree. The switcher is the directory listing the
 * values repo will hold, so what a change did to which file — and which folder
 * that file lives in — is visible without downloading anything.
 *
 * Once the connected repository has been read it is also a diff: the listing
 * opens on the files this tree would actually change, because forty-odd
 * unchanged files are what hides the two that moved. The button beside the
 * heading switches to the whole tree, and the heading says which is on screen —
 * the portal's own rule for a narrowed list.
 */
type Node = { name: string; path: string; children: Node[]; file?: TreeEntry };

/** The letter in the gutter, and nothing at all for a file that did not move. */
const MARK: Record<FileStatus, string> = { added: "A", modified: "M", removed: "D", unchanged: "" };

/** Paths into a folder tree, keeping generation order (base, then each namespace). */
function toTree(files: TreeEntry[]): Node[] {
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

type Props = {
  files: GeneratedFile[];
  onDownload: () => void;
  /** The connected branch's own files. `undefined` = not read, so there is nothing to compare against. */
  repo?: RepoFile[];
  /** True while that read is in flight — the difference between "no changes" and "not known yet". */
  comparing?: boolean;
  /** Whether the push deletes what it does not regenerate. See `diffTree`. */
  deletes?: boolean;
};

export function FilePreview({ files, onDownload, repo, comparing, deletes = false }: Props) {
  const [selected, setSelected] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const [onlyChanges, setOnlyChanges] = useState(true);

  const entries = useMemo<TreeEntry[]>(() => (repo ? diffTree(files, repo, deletes) : files), [files, repo, deletes]);
  const changed = useMemo(() => entries.filter((e) => e.status && e.status !== "unchanged"), [entries]);
  const diffing = !!repo && onlyChanges;
  const shown = diffing ? changed : entries;
  const tree = useMemo(() => toTree(shown), [shown]);

  // The selection survives an edit that renames a file out from under it — or
  // that takes it out of the narrowed list — by falling back to the first one.
  const file = shown.find((f) => f.path === selected) ?? shown[0];
  const body = file?.status === "removed" ? (file.repoText ?? "") : (file?.text ?? "");

  if (!entries.length) return <p className="empty-state">Add a release to see the files this tree generates.</p>;

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
        const status = node.file.status;
        return (
          <li key={node.path}>
            <button
              type="button"
              className={`ag-file${node.path === file!.path ? " selected" : ""}`}
              // The row shows the basename; the full path is what names it, so
              // a screen reader (and a test) still gets the whole thing.
              aria-label={status && status !== "unchanged" ? `${node.path} (${status})` : node.path}
              title={node.path}
              style={pad}
              onClick={() => setSelected(node.path)}
            >
              <span className={`ag-file-gutter${status ? ` st-${status}` : ""}`} aria-hidden="true">
                {status ? MARK[status] : ""}
              </span>
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
        <h3>
          {diffing ? `Changes vs the repository (${changed.length})` : `Generated files (${entries.length})`}
          {comparing && <span className="ag-file-note"> · reading the repository…</span>}
        </h3>
        <div className="ag-preview-actions">
          {repo && (
            // Names the list it switches *to*; the heading says which one is on
            // screen. The same shape the job lists' All/Mine toggle uses.
            <button type="button" className="ghost-button" onClick={() => setOnlyChanges((v) => !v)}>
              {diffing ? `All files (${entries.length})` : `Only changes (${changed.length})`}
            </button>
          )}
          <button
            type="button"
            className="ghost-button"
            disabled={!file}
            onClick={() => {
              void navigator.clipboard.writeText(body);
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
        <ul className="ag-file-list" aria-label={diffing ? "Changed files" : "Generated files"}>
          {render(tree, 0)}
        </ul>
        <div className="ag-file-pane">
          {file ? (
            <>
              {/* The path and what the file is for, once, above the file — rather
                  than repeated down a column that has no room for it. */}
              <p className="ag-file-path">
                {file.path} <span className="ag-file-note">{file.note}</span>
              </p>
              {file.status === "modified" ? (
                <Diff before={file.repoText ?? ""} after={file.text} />
              ) : (
                <pre className="ag-file-body">
                  <code>{body}</code>
                </pre>
              )}
            </>
          ) : (
            <p className="empty-state">This tree already matches the repository — nothing to commit.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** One file's lines: what the branch has, against what this tree generates. */
function Diff({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  return (
    <pre className="ag-file-body ag-diff">
      <code>
        {lines.map((line, i) => (
          <span key={i} className={line.kind === "+" ? "add" : line.kind === "-" ? "del" : "same"}>
            {line.kind}
            {line.text}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}
