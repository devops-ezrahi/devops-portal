import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModuleViewProps } from "../../moduleTypes";
import type { WhiteningJob } from "../../../server/types";
import { log, error as logError } from "../../log";
import { listJobs } from "./api";
import { JobDetail } from "./components/JobDetail";
import { JobList } from "./components/JobList";
import { ArchiveDropZone } from "./components/ArchiveDropZone";

export function WhiteningView({ user, isAdmin, refreshKey, onError }: ModuleViewProps) {
  const [jobs, setJobs] = useState<WhiteningJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  // Admins get everything from the server; the toggle narrows it back client-side,
  // same as the ticketing queue.
  const [showAll, setShowAll] = useState(true);
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

  function handleSubmitted(job: WhiteningJob) {
    log("whitening", "unpack job submitted", job);
    setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
    setSelectedJobId(job.id);
  }

  const visibleJobs = useMemo(
    () => (isAdmin && !showAll ? jobs.filter((j) => j.submittedBy === user.id) : jobs),
    [jobs, showAll, isAdmin, user.id]
  );

  const selectedJob = jobs.find((j) => j.id === selectedJobId) ?? null;

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
            <h2>{isAdmin && showAll ? "All Jobs" : "Recent Jobs"}</h2>
            {isAdmin && (
              <button
                className="ghost-button"
                onClick={() => {
                  log("whitening", `filter → ${showAll ? "my jobs" : "all jobs"}`);
                  setShowAll((v) => !v);
                }}
              >
                {showAll ? "All jobs" : "My jobs"}
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
              <JobDetail job={selectedJob} />
            </section>
          ) : (
            <section className="detail-panel art-panel" aria-label="New job">
              <ArchiveDropZone onSubmitted={handleSubmitted} onError={onError} />
            </section>
          )}
        </div>
      </div>
    </>
  );
}
