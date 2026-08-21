import { FlaskConical, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModuleViewProps } from "../../moduleTypes";
import type { WhiteningJob, WhiteningScenario } from "../../../server/types";
import { log, error as logError } from "../../log";
import { cancelJob, getJob, listJobs, simulateJob } from "./api";
import { JobDetail } from "./components/JobDetail";
import { JobList } from "./components/JobList";
import { ArchiveDropZone } from "./components/ArchiveDropZone";

// Mirrors WHITENING_SCENARIOS in server/modules/whitening/devSimulation.ts.
const TEST_SCENARIOS: { value: WhiteningScenario; label: string }[] = [
  { value: "success", label: "Success" },
  { value: "clone-failure", label: "Failure — repo not found" },
  { value: "dependency-failure", label: "Failure — dependency upload" },
  { value: "image-failure", label: "Failure — image push" },
];

export function WhiteningView({ user, isAdmin, refreshKey, onError }: ModuleViewProps) {
  const [jobs, setJobs] = useState<WhiteningJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  // The list is log-free (server strips it — a finished job's log lives on the
  // volume, not in the server's heap), so the drawer fetches the whole job.
  const [openJob, setOpenJob] = useState<WhiteningJob | null>(null);
  // Admins get everything from the server; the toggle narrows it back client-side,
  // same as the ticketing queue.
  const [showAll, setShowAll] = useState(true);
  const [testScenario, setTestScenario] = useState<WhiteningScenario>(TEST_SCENARIOS[0].value);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function fetchJobs() {
    listJobs()
      .then((result) => {
        log("whitening", `jobs loaded: ${result.jobs.length}`, {
          inProgress: result.jobs.filter((j) => j.status === "in-progress").length,
          statuses: result.jobs.map((j) => `${j.id}:${j.status}`),
        });
        setJobs(result.jobs);
      })
      .catch((err: Error) => {
        logError("whitening", "listJobs failed", err);
        onError(err.message);
      });
  }

  useEffect(() => {
    log("whitening", "view mounted / refreshed", { isAdmin, refreshKey });
    fetchJobs();
  }, [refreshKey]);

  useEffect(() => {
    log("whitening", "starting 2s job poll");
    intervalRef.current = setInterval(fetchJobs, 2000);
    return () => {
      log("whitening", "stopping job poll");
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // Same cadence as the list, but one job instead of all of them — which is
  // also why the list poll is now cheap: it no longer ships every log to every
  // open tab on every tick.
  useEffect(() => {
    if (!selectedJobId) {
      setOpenJob(null);
      return;
    }
    const fetchOpen = () =>
      getJob(selectedJobId)
        .then((result) => setOpenJob(result.job))
        .catch((err: Error) => logError("whitening", "getJob failed", err));
    fetchOpen();
    const id = setInterval(fetchOpen, 2000);
    return () => clearInterval(id);
  }, [selectedJobId]);

  function handleSubmitted(job: WhiteningJob) {
    log("whitening", "unpack job submitted", job);
    setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
    setSelectedJobId(job.id);
  }

  function handleStop(job: WhiteningJob) {
    log("whitening", "stopping job", job.id);
    cancelJob(job.id).then(fetchJobs).catch((err: Error) => {
      logError("whitening", "cancel failed", err);
      onError(err.message);
    });
  }

  const visibleJobs = useMemo(
    () => (isAdmin && !showAll ? jobs.filter((j) => j.submittedBy === user.id) : jobs),
    [jobs, showAll, isAdmin, user.id]
  );

  // Fall back to the list row until the full job lands, so selecting a job
  // paints immediately and only the log arrives a tick later.
  const selectedJob =
    (openJob?.id === selectedJobId ? openJob : null) ?? jobs.find((j) => j.id === selectedJobId) ?? null;

  return (
    <>
      <header className="topbar">
        <h1>Whitening</h1>
        {selectedJob && (
          <button className="primary" onClick={() => setSelectedJobId(null)}>
            <Plus size={18} aria-hidden="true" /> New Job
          </button>
        )}
      </header>

      <div className="workspace-grid">
        <div className="ticket-column">
          <div className="ticket-list-header">
            <h2>{isAdmin && showAll ? "All Jobs" : "My Jobs"}</h2>
            {isAdmin && (
              <button
                className="ghost-button"
                onClick={() => {
                  log("whitening", `filter → ${showAll ? "my jobs" : "all jobs"}`);
                  setShowAll((v) => !v);
                }}
              >
                {/* Labels the action, not the state — the heading beside it
                    already says which list you're looking at. */}
                {showAll ? "My jobs" : "All jobs"}
              </button>
            )}
          </div>
          <section className="ticket-list-panel" aria-label="Unpack jobs">
            <div className="ticket-list">
              <JobList
                jobs={visibleJobs}
                selectedJobId={selectedJobId}
                isAdmin={isAdmin}
                onSelect={(id) => {
                  log("whitening", selectedJobId === id ? "deselect job" : "select job", id);
                  setSelectedJobId((prev) => (prev === id ? null : id));
                }}
              />
            </div>
          </section>
        </div>

        <div className="content-column">
          {selectedJob ? (
            <section className="detail-panel" aria-label="Job detail">
              <JobDetail job={selectedJob} onStop={() => handleStop(selectedJob)} />
            </section>
          ) : (
            <section className="detail-panel art-panel" aria-label="New job">
              {/* Dev only: fires the server's scripted run so the step log and
                  Stop are reviewable with no Bitbucket/skopeo behind us. */}
              {user.id === "dev" && (
                <div className="panel-actions">
                  <div className="test-controls">
                    <select
                      className="test-scenario-select"
                      aria-label="Test scenario"
                      value={testScenario}
                      onChange={(e) => setTestScenario(e.target.value as WhiteningScenario)}
                    >
                      {TEST_SCENARIOS.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => {
                        log("whitening", "starting simulated run", testScenario);
                        simulateJob(testScenario)
                          .then((result) => handleSubmitted(result.job))
                          .catch((err: Error) => onError(err.message));
                      }}
                    >
                      <FlaskConical size={16} aria-hidden="true" /> Test
                    </button>
                  </div>
                </div>
              )}
              <ArchiveDropZone onSubmitted={handleSubmitted} onError={onError} />
            </section>
          )}
        </div>
      </div>
    </>
  );
}
