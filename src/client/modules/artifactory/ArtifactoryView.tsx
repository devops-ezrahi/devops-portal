import { FolderOpen, Link, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ModuleViewProps } from "../../moduleTypes";
import type { ArtifactoryJob } from "../../../server/types";
import { listJobs } from "./api";
import { JobDetail } from "./components/JobDetail";
import { JobList } from "./components/JobList";
import { FolderUploadForm } from "./components/FolderUploadForm";
import { UrlCopyForm } from "./components/UrlCopyForm";

type Tab = "url-copy" | "folder-upload";

export function ArtifactoryView({ isAdmin, refreshKey, onError }: ModuleViewProps) {
  const [activeTab, setActiveTab] = useState<Tab>("url-copy");
  const [jobs, setJobs] = useState<ArtifactoryJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function fetchJobs() {
    listJobs()
      .then((result) => setJobs(result.jobs))
      .catch((err: Error) => onError(err.message));
  }

  useEffect(() => {
    fetchJobs();
  }, [refreshKey]);

  useEffect(() => {
    intervalRef.current = setInterval(fetchJobs, 2000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  function handleSubmitted(job: ArtifactoryJob) {
    setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
    setSelectedJobId(job.id);
  }

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
            <h2>{isAdmin ? "All Jobs" : "Recent Jobs"}</h2>
          </div>
          <section className="ticket-list-panel" aria-label="Upload jobs">
            <div className="ticket-list">
              <JobList
                jobs={jobs}
                selectedJobId={selectedJobId}
                isAdmin={isAdmin}
                onSelect={(id) =>
                  setSelectedJobId((prev) => (prev === id ? null : id))
                }
              />
            </div>
          </section>
        </div>

        {/* Right: form (no selection) OR job detail (selection) */}
        <div className="content-column">
          {selectedJob ? (
            <section className="detail-panel" aria-label="Job detail">
              <JobDetail job={selectedJob} />
            </section>
          ) : (
            <section className="detail-panel art-panel" aria-label="New job">
              <div className="tab-bar">
                <button
                  className={`tab${activeTab === "url-copy" ? " active" : ""}`}
                  onClick={() => setActiveTab("url-copy")}
                >
                  <Link size={16} aria-hidden="true" />
                  Copy from URL
                </button>
                <button
                  className={`tab${activeTab === "folder-upload" ? " active" : ""}`}
                  onClick={() => setActiveTab("folder-upload")}
                >
                  <FolderOpen size={16} aria-hidden="true" />
                  Upload Folder
                </button>
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
