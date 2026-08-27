import { AlertTriangle, Check, Copy, Download } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import hljs from "highlight.js/lib/core";
import groovy from "highlight.js/lib/languages/groovy";
// rehype-highlight only tags code with .hljs-* classes and the AI module already
// pulls this theme in for the same reason — a duplicate import dedupes.
import "highlight.js/styles/atom-one-dark.css";
import { log, error as logError } from "../../../log";

hljs.registerLanguage("groovy", groovy);

type Props = {
  code: string;
  problems: string[];
};

export function JenkinsfilePreview({ code, problems }: Props) {
  const [copied, setCopied] = useState(false);
  const html = useMemo(() => hljs.highlight(code, { language: "groovy" }).value, [code]);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);

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
        <h2>Jenkinsfile</h2>
        <div className="jf-preview-actions">
          <button type="button" className="ghost-button" onClick={handleCopy}>
            {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className="ghost-button" onClick={handleDownload}>
            <Download size={16} aria-hidden="true" /> Download
          </button>
        </div>
      </div>

      {problems.length > 0 && (
        <ul className="jf-errors" aria-label="Pipeline problems">
          {problems.map((message) => (
            <li key={message}>
              <AlertTriangle size={14} aria-hidden="true" /> {message}
            </li>
          ))}
        </ul>
      )}

      <pre className="jf-code">
        <code className="hljs language-groovy" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}
