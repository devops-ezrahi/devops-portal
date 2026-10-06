import { useRef } from "react";
import { highlightGroovy } from "../highlight";

/** A Groovy card's body: the import dialog's editor, a highlighted copy behind a transparent textarea. */
export function GroovyEditor({
  value,
  onChange,
  label,
  id,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  id?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const shadow = useRef<HTMLPreElement>(null);
  return (
    <div className="jf-import-editor jf-groovy-editor">
      <pre className="jf-import-text jf-import-shadow" aria-hidden="true" ref={shadow}>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightGroovy(value) + "\n" }} />
      </pre>
      <textarea
        id={id}
        className="jf-import-text"
        aria-label={label}
        spellCheck={false}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        onScroll={(e) => {
          if (!shadow.current) return;
          shadow.current.scrollTop = e.currentTarget.scrollTop;
          shadow.current.scrollLeft = e.currentTarget.scrollLeft;
        }}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
