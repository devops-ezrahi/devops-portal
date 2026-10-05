import { Help } from "../../../Help";
import type { Workload } from "../api";

/**
 * The workloads a paste or chart holds, each a checkbox, all ticked to start.
 * A tick is by name — the converter's `--include =<name>` — so two kinds that
 * share a name are ticked together, and a microservice is converted when any
 * workload in it is ticked (the importer may group several into one). The
 * converter then trims `shared` to what two or more ticked microservices use.
 */
export function WorkloadPicker({
  workloads,
  off,
  loading,
  error,
  onToggle,
  onAll,
}: {
  workloads: Workload[] | null;
  off: Set<string>;
  loading: boolean;
  error: string;
  onToggle: (name: string) => void;
  onAll: (on: boolean) => void;
}) {
  const names = new Set((workloads ?? []).map((w) => w.name));
  const picked = [...names].filter((n) => !off.has(n)).length;
  const namespaces = new Set((workloads ?? []).map((w) => w.namespace));
  return (
    <div className="field-block ag-workloads">
      <span>
        Workloads
        <Help label="choosing workloads">
          <p>
            Untick what should not be converted. A microservice is converted when any of its workloads is ticked — the importer may group
            several (by <code>app.kubernetes.io/part-of</code>, then <code>app</code>) into one.
          </p>
          <p>
            The namespace's <code>shared</code> release keeps only what two or more of the converted microservices use. Something only one
            of them still uses moves into it, and what only unticked ones used is left out.
          </p>
        </Help>
        {workloads && workloads.length > 0 && (
          <span className="ag-workloads-actions">
            {picked} of {names.size}
            <button type="button" className="link-button" onClick={() => onAll(true)}>
              All
            </button>
            <button type="button" className="link-button" onClick={() => onAll(false)}>
              None
            </button>
          </span>
        )}
      </span>
      {loading && !workloads && <p className="field-hint">Looking for workloads…</p>}
      {error && <p className="field-hint">Could not list the workloads ({error}) — Convert takes all of them.</p>}
      {workloads && workloads.length === 0 && !loading && <p className="field-hint">No Deployment, StatefulSet, DaemonSet or Job found.</p>}
      {workloads && workloads.length > 0 && (
        <ul className="ag-workloads-list" aria-label="Workloads to convert">
          {workloads.map((w) => (
            <li key={`${w.kind}/${w.namespace}/${w.name}`}>
              <label>
                <input type="checkbox" checked={!off.has(w.name)} onChange={() => onToggle(w.name)} />
                <span className="ag-workloads-name">{w.name}</span>
                <span className="ag-workloads-kind">
                  {w.kind}
                  {namespaces.size > 1 ? ` · ${w.namespace}` : ""}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {workloads && workloads.length > 0 && picked === 0 && <p className="ag-new-error">Tick at least one workload to convert.</p>}
    </div>
  );
}
