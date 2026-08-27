import { FilePlus2, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ModuleViewProps } from "../../moduleTypes";
import type { JenkinsfilePipeline, JenkinsfileStage } from "../../../server/types";
import { log, error as logError } from "../../log";
import { createPipeline, deletePipeline, listPipelines, updatePipeline } from "./api";
import type { ArgSpec } from "./catalog";
import { toGroovy } from "./groovy";
import {
  createStage,
  newPipeline,
  stageLabel,
  toDraft,
  toInput,
  validatePipeline,
  type DraftPipeline,
  type MapPairs,
} from "./pipeline";
import { ArgField } from "./components/ArgField";
import { JenkinsfilePreview } from "./components/JenkinsfilePreview";
import { PipelineList } from "./components/PipelineList";
import { StageEditor } from "./components/StageEditor";
import { StageRail } from "./components/StageRail";

/**
 * `populateEnvVars` is a top-level call, not a stage, so it is edited here as
 * part of the pipeline rather than as a draggable card. Per-stage `envVars`
 * covers the narrower case (and is what the library recommends for parallel
 * builds, since populateEnvVars writes to the global env).
 */
const ENV_VARS_ARG: ArgSpec = {
  name: "envVars",
  label: "Environment variables",
  kind: "stringMap",
  hint: "Emitted as a populateEnvVars([...]) preamble. SERVICE and TEAM_NAME are the ones the library reads.",
};

export function JenkinsfileView({ user, isAdmin, refreshKey, onError }: ModuleViewProps) {
  const [pipelines, setPipelines] = useState<JenkinsfilePipeline[]>([]);
  const [draft, setDraft] = useState<DraftPipeline>(newPipeline);
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(true);
  const [saving, setSaving] = useState(false);

  function fetchPipelines() {
    listPipelines()
      .then((result) => {
        log("jenkinsfile", `pipelines loaded: ${result.pipelines.length}`);
        setPipelines(result.pipelines);
      })
      .catch((err: Error) => {
        logError("jenkinsfile", "listPipelines failed", err);
        onError(err.message);
      });
  }

  useEffect(() => {
    log("jenkinsfile", "view mounted / refreshed", { isAdmin, refreshKey });
    fetchPipelines();
  }, [refreshKey]);

  // Admins get every pipeline from the server; the toggle narrows it back
  // client-side, same as the ticketing queue and the whitening job list.
  const visiblePipelines = useMemo(
    () => (isAdmin && !showAll ? pipelines.filter((p) => p.createdBy === user.id) : pipelines),
    [pipelines, showAll, isAdmin, user.id]
  );
  const errors = useMemo(() => validatePipeline(draft), [draft]);
  const code = useMemo(() => toGroovy(draft), [draft]);
  const selectedStage = draft.stages.find((s) => s.id === selectedStageId) ?? null;

  function patchDraft(updates: Partial<DraftPipeline>) {
    setDraft((prev) => ({ ...prev, ...updates }));
  }

  function handleOpen(pipeline: JenkinsfilePipeline) {
    log("jenkinsfile", "opening pipeline", pipeline.id);
    setDraft(toDraft(pipeline));
    setSelectedStageId(pipeline.stages[0]?.id ?? null);
  }

  function handleNew() {
    log("jenkinsfile", "new pipeline");
    setDraft(newPipeline());
    setSelectedStageId(null);
  }

  function handleAddStage(step: string) {
    const stage = createStage(step);
    log("jenkinsfile", "adding stage", step, stage.id);
    setDraft((prev) => ({ ...prev, stages: [...prev.stages, stage] }));
    setSelectedStageId(stage.id);
  }

  function handleStageChange(stage: JenkinsfileStage) {
    setDraft((prev) => ({ ...prev, stages: prev.stages.map((s) => (s.id === stage.id ? stage : s)) }));
  }

  function handleRemoveStage(id: string) {
    log("jenkinsfile", "removing stage", id);
    setDraft((prev) => ({ ...prev, stages: prev.stages.filter((s) => s.id !== id) }));
    setSelectedStageId((prev) => (prev === id ? null : prev));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const input = toInput(draft);
      const { pipeline } = draft.id ? await updatePipeline(draft.id, input) : await createPipeline(input);
      log("jenkinsfile", draft.id ? "updated" : "created", pipeline.id);
      setDraft(toDraft(pipeline));
      setPipelines((prev) => [pipeline, ...prev.filter((p) => p.id !== pipeline.id)]);
    } catch (err) {
      logError("jenkinsfile", "save failed", err);
      onError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!draft.id) return;
    const id = draft.id;
    try {
      await deletePipeline(id);
      log("jenkinsfile", "deleted", id);
      setPipelines((prev) => prev.filter((p) => p.id !== id));
      handleNew();
    } catch (err) {
      logError("jenkinsfile", "delete failed", err);
      onError(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  return (
    <>
      <header className="topbar">
        <h1>Jenkinsfile</h1>
        <div className="jf-topbar-actions">
          {draft.id && (
            <button type="button" className="ghost-button" onClick={() => void handleDelete()}>
              <Trash2 size={17} aria-hidden="true" /> Delete
            </button>
          )}
          <button type="button" className="ghost-button" onClick={handleNew}>
            <FilePlus2 size={17} aria-hidden="true" /> New
          </button>
          <button
            type="button"
            className="primary"
            disabled={saving || !draft.name.trim()}
            title={draft.name.trim() ? undefined : "Give the pipeline a name first"}
            onClick={() => void handleSave()}
          >
            <Save size={17} aria-hidden="true" /> {saving ? "Saving…" : draft.id ? "Save" : "Save as new"}
          </button>
        </div>
      </header>

      <div className="workspace-grid">
        <div className="ticket-column">
          <div className="ticket-list-header">
            <h2>{isAdmin && showAll ? "All Pipelines" : "My Pipelines"}</h2>
            {isAdmin && (
              <button className="ghost-button" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "My pipelines" : "All pipelines"}
              </button>
            )}
          </div>
          <section className="ticket-list-panel" aria-label="Saved pipelines">
            <div className="ticket-list">
              <PipelineList
                pipelines={visiblePipelines}
                selectedId={draft.id}
                isAdmin={isAdmin}
                onSelect={(id) => {
                  const pipeline = visiblePipelines.find((p) => p.id === id);
                  if (pipeline) handleOpen(pipeline);
                }}
              />
            </div>
          </section>
        </div>

        <div className="content-column">
          <section className="detail-panel" aria-label="Pipeline settings">
            <div className="jf-settings">
              <div className="form-field">
                <label htmlFor="jf-name">Pipeline name</label>
                <input
                  id="jf-name"
                  type="text"
                  value={draft.name}
                  placeholder="my-service pipeline"
                  onChange={(e) => patchDraft({ name: e.target.value })}
                />
                <span className="field-hint">Only used to find it in the list — it is not written into the file.</span>
              </div>
              <div className="form-field">
                <label htmlFor="jf-library">Shared library</label>
                <input
                  id="jf-library"
                  type="text"
                  value={draft.library}
                  onChange={(e) => patchDraft({ library: e.target.value })}
                />
                <span className="field-hint">
                  Goes inside <code>@Library('…') _</code>. Add <code>@branch</code> to pin a version.
                </span>
              </div>
            </div>
            <ArgField
              spec={ENV_VARS_ARG}
              value={draft.envVars}
              idPrefix="jf-pipeline"
              onChange={(value) => patchDraft({ envVars: value as MapPairs })}
            />
          </section>

          <section className="detail-panel jf-builder" aria-label="Stages">
            <div className="jf-build-grid">
              <StageRail
                stages={draft.stages}
                selectedId={selectedStageId}
                errors={errors.stages}
                onSelect={setSelectedStageId}
                onReorder={(stages) => patchDraft({ stages })}
                onAdd={handleAddStage}
                onRemove={handleRemoveStage}
              />
              {selectedStage ? (
                <StageEditor
                  key={selectedStage.id}
                  stage={selectedStage}
                  errors={errors.stages[selectedStage.id] ?? []}
                  onChange={handleStageChange}
                  onRemove={() => handleRemoveStage(selectedStage.id)}
                />
              ) : (
                <p className="jf-empty jf-editor">
                  {draft.stages.length
                    ? `Pick a stage on the left to edit it — ${stageLabel(draft.stages[0])} first.`
                    : "Add a stage on the left, then drag the cards to reorder the pipeline."}
                </p>
              )}
            </div>
          </section>

          <section className="detail-panel" aria-label="Generated Jenkinsfile">
            <JenkinsfilePreview code={code} problems={errors.pipeline} />
          </section>
        </div>
      </div>
    </>
  );
}
