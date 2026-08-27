import type { JenkinsfilePipeline } from "../../../../server/types";

type Props = {
  pipelines: JenkinsfilePipeline[];
  selectedId: string;
  isAdmin: boolean;
  onSelect: (id: string) => void;
};

/** Same row shape as every other module's list panel. */
export function PipelineList({ pipelines, selectedId, isAdmin, onSelect }: Props) {
  if (pipelines.length === 0) {
    return <div className="empty-state">No saved pipelines yet. Build one and press Save.</div>;
  }

  return (
    <>
      {pipelines.map((pipeline) => (
        <button
          key={pipeline.id}
          className={`ticket-row${selectedId === pipeline.id ? " selected" : ""}`}
          onClick={() => onSelect(pipeline.id)}
        >
          <strong>{pipeline.name}</strong>
          <div className="ticket-row-meta">
            <small>
              {pipeline.stages.length} stage{pipeline.stages.length === 1 ? "" : "s"}
            </small>
            {/* Admins see every pipeline, so the owner is the useful column; a
                user is only ever looking at their own. */}
            <small dir="auto">{isAdmin ? pipeline.createdByName : pipeline.id}</small>
          </div>
        </button>
      ))}
    </>
  );
}
