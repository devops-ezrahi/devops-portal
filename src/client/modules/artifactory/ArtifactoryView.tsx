import { FlaskConical, FolderOpen, Link, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModuleViewProps } from "../../moduleTypes";
import type { ArtifactoryJob } from "../../../server/types";
import { log, error as logError } from "../../log";
import { cancelJob, listJobs, simulateJob } from "./api";
import { JobDetail } from "./components/JobDetail";
import { JobList } from "./components/JobList";
import { FolderUploadForm } from "./components/FolderUploadForm";
import { UrlCopyForm } from "./components/UrlCopyForm";

type Tab = "url-copy" | "folder-upload";

export function ArtifactoryView({ user, isAdmin, refreshKey, onError }: ModuleViewProps) {
  const [activeTab, setActiveTab] = useState<Tab>("url-copy");
  const [jobs, setJobs] = useState<ArtifactoryJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  // Admins get everything from the server; the toggle narrows it back client-side,
  // same as the ticketing queue.
  const [showAll, setShowAll] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function fetchJobs() {
    listJobs()
      .then((result) => {
        log("artifactory", `jobs loaded: ${result.jobs.length}`, {
          inProgress: result.jobs.filter((j) => j.status === "in-progress").length,
          statuses: result.jobs.map((j) => `${j.id}:${j.status}`),
        });
        setJobs(result.jobs);
      })
      .catch((err: Error) => {
        logError("artifactory", "listJobs failed", err);
        onError(err.message);
      });
  }

  useEffect(() => {
    log("artifactory", "view mounted / refreshed", { isAdmin, refreshKey, activeTab });
    fetchJobs();
  }, [refreshKey]);

  useEffect(() => {
    log("artifactory", "starting 2s job poll");
    intervalRef.current = setInterval(fetchJobs, 2000);
    return () => {
      log("artifactory", "stopping job poll");
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  function handleSubmitted(job: ArtifactoryJob) {
    log("artifactory", "job submitted", job);
    setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
    setSelectedJobId(job.id);
  }

  function handleStop(job: ArtifactoryJob) {
    log("artifactory", "stopping job", job.id);
    cancelJob(job.id).then(fetchJobs).catch((err: Error) => {
      logError("artifactory", "cancel failed", err);
      onError(err.message);
    });
  }

  const visibleJobs = useMemo(
    () => (isAdmin && !showAll ? jobs.filter((j) => j.submittedBy === user.id) : jobs),
    [jobs, showAll, isAdmin, user.id]
  );

  const selectedJob = jobs.find((j) => j.id === selectedJobId) ?? null;

  return (
    <>
      <header className="topbar">
        <h1>Artifactory</h1>
        {selectedJob && (
          <button className="primary" onClick={() => setSelectedJobId(null)}>
            <Plus size={18} aria-hidden="true" /> New Job
          </button>
        )}
      </header>

      <div className="workspace-grid">
        {/* Left: job history */}
        <div className="ticket-column">
          <div className="ticket-list-header">
            <h2>{isAdmin && showAll ? "All Jobs" : "Recent Jobs"}</h2>
            {isAdmin && (
              <button
                className="ghost-button"
                onClick={() => {
                  log("artifactory", `filter → ${showAll ? "my jobs" : "all jobs"}`);
                  setShowAll((v) => !v);
                }}
              >
                {showAll ? "All jobs" : "My jobs"}
              </button>
            )}
          </div>
          <section className="ticket-list-panel" aria-label="Upload jobs">
            <div className="ticket-list">
              <JobList
                jobs={visibleJobs}
                selectedJobId={selectedJobId}
                isAdmin={isAdmin}
                onSelect={(id) => {
                  log("artifactory", selectedJobId === id ? "deselect job" : "select job", id);
                  setSelectedJobId((prev) => (prev === id ? null : id));
                }}
              />
            </div>
          </section>
        </div>

        {/* Right: form (no selection) OR job detail (selection) */}
        <div className="content-column">
          {selectedJob ? (
            <section className="detail-panel" aria-label="Job detail">
              <JobDetail job={selectedJob} onStop={() => handleStop(selectedJob)} />
            </section>
          ) : (
            <section className="detail-panel art-panel" aria-label="New job">
              <div className="tab-bar">
                <button
                  className={`tab${activeTab === "url-copy" ? " active" : ""}`}
                  onClick={() => { log("artifactory", "tab → url-copy"); setActiveTab("url-copy"); }}
                >
                  <Link size={16} aria-hidden="true" />
                  Copy from URL
                </button>
                <button
                  className={`tab${activeTab === "folder-upload" ? " active" : ""}`}
                  onClick={() => { log("artifactory", "tab → folder-upload"); setActiveTab("folder-upload"); }}
                >
                  <FolderOpen size={16} aria-hidden="true" />
                  Upload Folder
                </button>
                {/* Dev only: fires the server's scripted run so the log, the
                    progress bar and Stop are reviewable with no Artifactory. */}
                {user.id === "dev" && (
                  <button
                    type="button"
                    className="ghost-button tab-bar-action"
                    onClick={() => {
                      log("artifactory", "starting simulated run");
                      simulateJob()
                        .then((result) => handleSubmitted(result.job))
                        .catch((err: Error) => onError(err.message));
                    }}
                  >
                    <FlaskConical size={16} aria-hidden="true" /> Test
                  </button>
                )}
              </div>

              {activeTab === "url-copy" ? (
                <UrlCopyForm onSubmitted={handleSubmitted} onError={onError} />
              ) : (
                <FolderUploadForm onSubmitted={handleSubmitted} onError={onError} />
              )}
            </section>
          )}
        </div>
      </div>
    </>
  );
}
