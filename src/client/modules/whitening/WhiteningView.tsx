import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ModuleViewProps } from "../../moduleTypes";
import type { WhiteningJob } from "../../../server/types";
import { listJobs } from "./api";
import { JobDetail } from "./components/JobDetail";
import { JobList } from "./components/JobList";
import { ZipDropZone } from "./components/ZipDropZone";

export function WhiteningView({ isAdmin, refreshKey, onError }: ModuleViewProps) {
  const [jobs, setJobs] = useState<WhiteningJob[]>([]);
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

  function handleSubmitted(job: WhiteningJob) {
    setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
    setSelectedJobId(job.id);
  }

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
            <h2>{isAdmin ? "All Jobs" : "Recent Jobs"}</h2>
          </div>
          <section className="ticket-list-panel" aria-label="Unpack jobs">
            <div className="ticket-list">
              <JobList
                jobs={jobs}
                selectedJobId={selectedJobId}
                isAdmin={isAdmin}
                onSelect={(id) => setSelectedJobId((prev) => (prev === id ? null : id))}
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
              <ZipDropZone onSubmitted={handleSubmitted} onError={onError} />
            </section>
          )}
        </div>
      </div>
    </>
  );
}
