import { Library, Plus, X } from "lucide-react";
import { Help } from "../../../Help";

type Props = {
  /** What goes inside `@Library('…')` — empty means no import line at all. */
  value: string;
  /** The library name this deployment uses, from JENKINS_SHARED_LIBRARY. */
  name: string;
  onChange: (value: string) => void;
};

/**
 * The `@Library` import, which is optional and half fixed.
 *
 * The library's *name* is a deployment fact, not a per-user choice — there is
 * one of them, and typing it into every pipeline only creates the chance to
 * typo it. So the name comes from configuration and the only thing on screen is
 * the branch to pin, if any.
 *
 * Off is the resting state: a dotted button, in the shape of the box it opens
 * into, so adding the import reads as filling in a slot rather than growing a
 * new section.
 */
export function LibraryField({ value, name, onChange }: Props) {
  const at = value.indexOf("@");
  const branch = at === -1 ? "" : value.slice(at + 1);

  if (!value) {
    return (
      <button type="button" className="jf-dotted" onClick={() => onChange(name)}>
        <Plus size={15} aria-hidden="true" />
        <span>
          <strong>Import the shared library</strong>
          <small>
            Adds <code>@Library('{name}') _</code> at the top. Optional — a pipeline that calls no library
            step does not need it.
          </small>
        </span>
      </button>
    );
  }

  return (
    <div className="jf-arg jf-library">
      <div className="jf-arg-head">
        <Library size={15} aria-hidden="true" className="jf-library-icon" />
        <label htmlFor="jf-library-branch">{name}</label>
        <Help label="the library branch">
          <p>
            Branch, tag or version to pin — leave empty for the library&rsquo;s default. Emitted as{" "}
            <code>@Library(&apos;{value}&apos;) _</code>.
          </p>
        </Help>
        <button
          type="button"
          className="icon-button"
          aria-label="Remove the shared library import"
          title="Remove the shared library import"
          onClick={() => onChange("")}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <input
        id="jf-library-branch"
        type="text"
        spellCheck={false}
        placeholder="(default branch)"
        value={branch}
        // Only the branch is editable, so the name can never drift from the
        // one the Jenkins controller actually has configured.
        onChange={(e) => onChange(e.target.value.trim() ? `${name}@${e.target.value.trim()}` : name)}
      />
    </div>
  );
}
