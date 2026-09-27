import { Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { Help } from "../../../Help";
import { highlightGroovy } from "../highlight";

/**
 * Top-level Groovy, written between the parameters and the stages: variables a
 * stage's commands interpolate (`${tag}`) and functions a Closure command
 * calls. Written through as typed — this is code, not a value to quote — and
 * read back out of an imported file by `splitDefs`.
 *
 * Off is the resting state, the same dotted button the parameters use.
 */
export function GroovyBlock({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const shadow = useRef<HTMLPreElement>(null);

  if (!value && !open) {
    return (
      <button type="button" className="jf-dotted" onClick={() => setOpen(true)}>
        <Plus size={15} aria-hidden="true" />
        <span>
          <strong>Add Groovy variables and functions</strong>
          <small>
            Declared before the stages — <code>def tag = "1.0.$&#123;env.BUILD_NUMBER&#125;"</code>, then{" "}
            <code>$&#123;tag&#125;</code> in a stage&rsquo;s commands.
          </small>
        </span>
      </button>
    );
  }

  return (
    <div className="jf-groovy">
      <div className="jf-list-head">
        <h2>
          Groovy
          <Help label="Groovy variables and functions">
            <p>
              Written into the Jenkinsfile as-is, after the parameters and before the first stage — so every stage can
              use what is declared here.
            </p>
            <p>
              A variable goes into a shell command as <code>$&#123;name&#125;</code> (the command is then written as a
              GString). A function is called from a stage&rsquo;s <strong>Closure</strong> commands.
            </p>
            <p>
              A <code>def</code> variable is local to the script body, so a function cannot see it. Mark one{" "}
              <code>@Field</code> (with <code>import groovy.transform.Field</code>) when a function needs it.
            </p>
          </Help>
        </h2>
        <button
          type="button"
          className="icon-button jf-head-action"
          aria-label="Remove the Groovy block"
          onClick={() => {
            onChange("");
            setOpen(false);
          }}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      {/* The import dialog's editor: a highlighted copy behind a transparent textarea. */}
      <div className="jf-import-editor jf-groovy-editor">
        <pre className="jf-import-text jf-import-shadow" aria-hidden="true" ref={shadow}>
          <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightGroovy(value) + "\n" }} />
        </pre>
        <textarea
          className="jf-import-text"
          aria-label="Groovy variables and functions"
          spellCheck={false}
          autoFocus={!value}
          placeholder={'def registry = "ghcr.io/shop"\n\ndef notify(String msg) {\n    echo "done: ${msg}"\n}'}
          value={value}
          onScroll={(e) => {
            if (!shadow.current) return;
            shadow.current.scrollTop = e.currentTarget.scrollTop;
            shadow.current.scrollLeft = e.currentTarget.scrollLeft;
          }}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}
