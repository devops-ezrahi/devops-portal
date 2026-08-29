import { Check, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModuleViewProps } from "../../moduleTypes";
import type { JenkinsfileParam, JenkinsfilePipeline, JenkinsfileStage } from "../../../server/types";
import { log, error as logError } from "../../log";
import { createPipeline, deletePipeline, getImages, listPipelines, updatePipeline, type PickableImage } from "./api";
import { toGroovy } from "./groovy";
import {
  createStage,
  DEFAULT_LIBRARY,
  newPipeline,
  toDraft,
  toInput,
  validatePipeline,
  type DraftPipeline,
} from "./pipeline";
import { JenkinsfilePreview } from "./components/JenkinsfilePreview";
import { LibraryField } from "./components/LibraryField";
import { ParamsEditor } from "./components/ParamsEditor";
import { PipelineList } from "./components/PipelineList";
import { ImagesContext } from "./components/ArgField";
import { NewPipelineDialog } from "./components/NewPipelineDialog";
import { StageList } from "./components/StageList";

/** The `touched` key standing for the pipeline itself rather than one stage. */
const PIPELINE_SCOPE = "pipeline";

/** The pipeline the Refresh button (and a page reload) reopens. */
const LAST_OPENED_KEY = "jenkinsfile.lastOpened";

/** How long to sit on a change before writing it. One keystroke is not an edit. */
const AUTOSAVE_MS = 800;

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Problems show for a part of the page once you have pressed outside it — a
 * field you have not filled in yet is not a mistake while you are still in it.
 *
 * One document listener rather than a handler per card: the press that reveals a
 * stage's problems usually lands on some other stage, or on the page background,
 * neither of which the card itself can see. Elements opt in by carrying
 * `data-touch-scope`; everything whose scope is not the one pressed has been
 * left. Tabbing out is handled separately, by each card's own `onBlur` — a
 * keyboard user may never press anything.
 */
function useLeaveScopes(onLeave: (scope: string) => void, scopes: string[]) {
  const latest = useRef({ onLeave, scopes });
  latest.current = { onLeave, scopes };

  useEffect(() => {
    function onDown(e: PointerEvent) {
      const inside = (e.target as Element | null)?.closest?.("[data-touch-scope]");
      const pressed = inside?.getAttribute("data-touch-scope");
      for (const scope of latest.current.scopes) {
        if (scope !== pressed) latest.current.onLeave(scope);
      }
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);
}

export function JenkinsfileView({ user, isAdmin, refreshKey, onError }: ModuleViewProps) {
  const [pipelines, setPipelines] = useState<JenkinsfilePipeline[]>([]);
  const [draft, setDraft] = useState<DraftPipeline>(newPipeline);
  /**
   * Which parts have been left once. Problems are computed from the first
   * keystroke but only shown for a stage you have finished with — an empty field
   * you are still in the middle of is not a mistake yet. Keyed by stage id, plus
   * PIPELINE_SCOPE for the parameters.
   */
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(true);
  /** The configured library name, which the server sends alongside the list. */
  const [sharedLibrary, setSharedLibrary] = useState(DEFAULT_LIBRARY);
  const [images, setImages] = useState<PickableImage[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  /** The id the next write should PUT to. A ref, because the write queue reads it after an await. */
  const idRef = useRef("");
  /**
   * The JSON of what is already on the server, so an edit that lands back in the
   * same shape is not written again. Set from the *response*, not the request,
   * so a normalisation the server makes does not read as a pending change and
   * loop.
   */
  const persisted = useRef("");
  /** One write at a time: a create must finish and hand back an id before the next PUT. */
  const queue = useRef<Promise<void>>(Promise.resolve());

  function fetchPipelines() {
    listPipelines()
      .then((result) => {
        log("jenkinsfile", `pipelines loaded: ${result.pipelines.length}`);
        setPipelines(result.pipelines);
        if (result.sharedLibrary) setSharedLibrary(result.sharedLibrary);
        // Reopen whatever was last open, so Refresh lands back where you were.
        // Only into an untouched draft: a load that resolves late must not take
        // the editor away from a pipeline already opened by hand.
        const last = result.pipelines.find((p) => p.id === localStorage.getItem(LAST_OPENED_KEY));
        if (last && !idRef.current) handleOpen(last);
      })
      .catch((err: Error) => {
        logError("jenkinsfile", "listPipelines failed", err);
        onError(err.message);
      });
  }

  useEffect(() => {
    log("jenkinsfile", "view mounted / refreshed", { isAdmin, refreshKey });
    fetchPipelines();
    // Its own request, not part of the list load: this one goes out to
    // Artifactory, and a failure must cost nothing more than an image field
    // with no suggestions in it — so it is not surfaced through onError.
    getImages()
      .then((result) => setImages(result.images))
      .catch((err: Error) => logError("jenkinsfile", "getImages failed", err));
  }, [refreshKey]);

  // Admins get every pipeline from the server; the toggle narrows it back
  // client-side, same as the ticketing queue and the whitening job list.
  const visiblePipelines = useMemo(
    () => (isAdmin && !showAll ? pipelines.filter((p) => p.createdBy === user.id) : pipelines),
    [pipelines, showAll, isAdmin, user.id]
  );
  const code = useMemo(() => toGroovy(draft), [draft]);
  const errors = useMemo(() => {
    const all = validatePipeline(draft);
    return {
      pipeline: touched.has(PIPELINE_SCOPE) ? all.pipeline : [],
      stages: Object.fromEntries(Object.entries(all.stages).filter(([id]) => touched.has(id))),
    };
  }, [draft, touched]);

  function patchDraft(updates: Partial<DraftPipeline>) {
    setDraft((prev) => ({ ...prev, ...updates }));
  }

  function handleOpen(pipeline: JenkinsfilePipeline) {
    log("jenkinsfile", "opening pipeline", pipeline.id);
    localStorage.setItem(LAST_OPENED_KEY, pipeline.id);
    // Which cards are folded was saved with it, so it opens the way it was left.
    const opened = toDraft(pipeline);
    setDraft(opened);
    // It came from the server, so it is already written — otherwise merely
    // opening one would write it straight back.
    idRef.current = pipeline.id;
    persisted.current = JSON.stringify(toInput(opened));
    setTouched(new Set());
    setSaveState("idle");
  }

  /** Both ways of starting: `start` is the pipeline to open, empty or imported. */
  function startPipeline(start: DraftPipeline) {
    setDraft(start);
    idRef.current = "";
    persisted.current = "";
    setTouched(new Set());
    setSaveState("idle");
    setNewOpen(false);
    localStorage.removeItem(LAST_OPENED_KEY);
  }

  function handleNew() {
    log("jenkinsfile", "new pipeline");
    startPipeline(newPipeline());
  }

  function handleImport(imported: DraftPipeline, warnings: string[]) {
    log("jenkinsfile", `imported: ${imported.stages.length} stage(s)`, { warnings: warnings.length });
    // Autosave takes it from here — an import is a change like any other, so it
    // lands in the list on the same debounce as typing does.
    startPipeline(imported);
  }

  function touch(scope: string) {
    setTouched((prev) => (prev.has(scope) ? prev : new Set(prev).add(scope)));
  }

  useLeaveScopes(touch, [PIPELINE_SCOPE, ...draft.stages.map((s) => s.id)]);

  function handleAddStage(step: string) {
    const stage = createStage(step);
    log("jenkinsfile", "adding stage", step, stage.id);
    // populateEnvVars is a preamble wherever it is put, so it goes to the front —
    // anything reading $SERVICE has to run after it.
    setDraft((prev) => ({
      ...prev,
      stages: step === "populateEnvVars" ? [stage, ...prev.stages] : [...prev.stages, stage],
    }));
  }

  function toggleStage(id: string) {
    setDraft((prev) => ({
      ...prev,
      stages: prev.stages.map((s) => (s.id === id ? { ...s, collapsed: !s.collapsed } : s)),
    }));
  }

  function collapseAll(collapsed: boolean) {
    setDraft((prev) => ({ ...prev, stages: prev.stages.map((s) => ({ ...s, collapsed })) }));
  }

  function handleStageChange(stage: JenkinsfileStage) {
    setDraft((prev) => ({ ...prev, stages: prev.stages.map((s) => (s.id === stage.id ? stage : s)) }));
  }

  function handleRemoveStage(id: string) {
    log("jenkinsfile", "removing stage", id);
    setDraft((prev) => ({ ...prev, stages: prev.stages.filter((s) => s.id !== id) }));
    setTouched((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  /**
   * Autosave. There is no Save button — a pipeline is a document, and the list
   * is where you come back to it — so every change is written after a pause.
   * A draft nobody has touched is not written at all: opening the module must
   * not litter the list with empty pipelines.
   */
  useEffect(() => {
    const input = toInput(draft);
    const json = JSON.stringify(input);
    if (json === persisted.current) return;
    if (!draft.id && input.stages.length === 0 && input.params.length === 0) return;

    const timer = setTimeout(() => {
      queue.current = queue.current.then(() => write(input, json));
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  async function write(input: ReturnType<typeof toInput>, json: string) {
    if (json === persisted.current) return;
    setSaveState("saving");
    try {
      // `id` is read at write time rather than captured: the create that ran
      // just before this one in the queue is what put it there.
      const id = idRef.current;
      const { pipeline } = id ? await updatePipeline(id, input) : await createPipeline(input);
      idRef.current = pipeline.id;
      // A pipeline created by autosave is now the one Refresh should reopen.
      localStorage.setItem(LAST_OPENED_KEY, pipeline.id);
      persisted.current = JSON.stringify(toInput(toDraft(pipeline)));
      log("jenkinsfile", id ? "autosaved" : "created", pipeline.id);
      // Only the server's own fields are taken back. Merging the whole record
      // would stamp on whatever was typed while the request was in flight.
      setDraft((prev) => ({
        ...prev,
        id: pipeline.id,
        updatedAt: pipeline.updatedAt,
        // The minted name is taken back only when there was nothing to keep:
        // this field is typed in now, and a slow response must not overwrite
        // whatever was typed while it was in flight.
        name: prev.name.trim() ? prev.name : pipeline.name,
      }));
      setPipelines((prev) => [pipeline, ...prev.filter((p) => p.id !== pipeline.id)]);
      setSaveState("saved");
    } catch (err) {
      logError("jenkinsfile", "autosave failed", err);
      onError(err instanceof Error ? err.message : "Failed to save");
      setSaveState("error");
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
    <ImagesContext.Provider value={images}>
      <header className="topbar">
        <h1>Jenkinsfile</h1>
        <div className="jf-topbar-actions">
          <span className={`jf-save-state ${saveState}`} role="status">
            {saveState === "saving" && "Saving…"}
            {saveState === "saved" && (
              <>
                <Check size={15} aria-hidden="true" /> Saved
              </>
            )}
            {saveState === "error" && (
              <>
                <TriangleAlert size={15} aria-hidden="true" /> Not saved
              </>
            )}
          </span>
          {draft.id && (
            <button type="button" className="ghost-button" onClick={() => void handleDelete()}>
              <Trash2 size={18} aria-hidden="true" /> Delete
            </button>
          )}
          {/* Same button as every other module's: primary, a Plus, and last in
              the bar. The thing this module makes is a pipeline, so New here
              means what New means everywhere else. */}
          <button type="button" className="primary" onClick={() => setNewOpen(true)}>
            <Plus size={18} aria-hidden="true" /> New
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
          {/* The open pipeline's name heads the editor, level with the list
              heading beside it — it names what the whole column is showing, so
              it belongs above the column rather than tucked into the toolbar.
              Text with a pencil, the same shape a ticket's title uses, because
              a box sitting there permanently reads as a search field. A list of
              "Dev User #7" says nothing about what any of them build; the
              server still mints that name and this renames over it. */}
          <div className="jf-title-row">
            {naming ? (
              <input
                className="title-edit-input jf-title"
                aria-label="Pipeline name"
                value={draft.name}
                placeholder="Untitled pipeline"
                autoFocus
                onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
                onBlur={() => setNaming(false)}
                onKeyDown={(e) => {
                  // Enter and Escape both just leave the field — every keystroke
                  // is already in the draft, and autosave is what writes it.
                  if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
                }}
              />
            ) : (
              <h2 className={`jf-title${draft.name.trim() ? "" : " jf-title-empty"}`}>{draft.name.trim() || "Untitled pipeline"}</h2>
            )}
            <button
              type="button"
              className="icon-button edit-toggle"
              aria-label={naming ? "Done editing the name" : "Rename this pipeline"}
              onClick={() => setNaming((v) => !v)}
            >
              {naming ? <Check size={16} aria-hidden="true" /> : <Pencil size={16} aria-hidden="true" />}
            </button>
          </div>

          <section className="detail-panel" aria-label="Pipeline settings">
            <LibraryField
              value={draft.library}
              name={sharedLibrary}
              onChange={(library) => patchDraft({ library })}
            />
          </section>

          <section
            className="detail-panel"
            aria-label="Pipeline parameters"
            data-touch-scope={PIPELINE_SCOPE}
            onBlur={(e) => {
              if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget)) touch(PIPELINE_SCOPE);
            }}
          >
            <ParamsEditor params={draft.params} onChange={(params) => patchDraft({ params })} />
          </section>

          <section className="detail-panel jf-builder" aria-label="Stages">
            <StageList
              stages={draft.stages}
              errors={errors.stages}
              onToggle={toggleStage}
              onCollapseAll={collapseAll}
              onReorder={(stages) => patchDraft({ stages })}
              onChange={handleStageChange}
              onLeave={touch}
              onAdd={handleAddStage}
              onRemove={handleRemoveStage}
            />
          </section>

          <section className="detail-panel" aria-label="Generated Jenkinsfile">
            <JenkinsfilePreview code={code} problems={errors.pipeline} />
          </section>
        </div>
      </div>
      {newOpen && (
        <NewPipelineDialog onScratch={handleNew} onImport={handleImport} onClose={() => setNewOpen(false)} />
      )}
    </ImagesContext.Provider>
  );
}
