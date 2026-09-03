import { FlaskConical, FolderOpen, Link, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { idFromPath, useDeepLink } from "../../deepLink";
import type { ModuleViewProps } from "../../moduleTypes";
import type { ArtifactoryJob, ArtifactoryScenario } from "../../../server/types";
import { log, error as logError } from "../../log";
import { cancelJob, getJob, listJobs, simulateJob } from "./api";
import { JobDetail } from "./components/JobDetail";
import { JobList } from "./components/JobList";
import { FolderUploadForm } from "./components/FolderUploadForm";
import { UrlCopyForm } from "./components/UrlCopyForm";

type Tab = "url-copy" | "folder-upload";

// Mirrors ARTIFACTORY_SCENARIOS in server/modules/artifactory/devSimulation.ts.
const TEST_SCENARIOS: { value: ArtifactoryScenario; label: string }[] = [
  { value: "npm", label: "npm — success" },
  { value: "maven", label: "Maven — success" },
  { value: "rpm", label: "RPM — success" },
  { value: "pypi", label: "PyPI — success" },
  { value: "helm", label: "Helm — success" },
  { value: "partial-failure", label: "npm — one package fails" },
  { value: "total-failure", label: "npm — Artifactory unreachable" },
  { value: "dependency-fallback", label: "npm — dependencies not resolved" },
];

export function ArtifactoryView({ user, isAdmin, refreshKey, onError }: ModuleViewProps) {
  const [activeTab, setActiveTab] = useState<Tab>("url-copy");
  const [jobs, setJobs] = useState<ArtifactoryJob[]>([]);
  // From the URL on first paint, so /artifactory/ART-0007 opens that job.
  const [selectedJobId, setSelectedJobId] = useState<string | null>(() => idFromPath("artifactory"));
  // The list is log-free (server strips it — a finished job's log lives on the
  // volume, not in the server's heap), so the drawer fetches the whole job.
  const [openJob, setOpenJob] = useState<ArtifactoryJob | null>(null);
  // Admins get everything from the server; the toggle narrows it back client-side,
  // same as the ticketing queue.
  // Own jobs first: an admin opening the module wants their own run, not a
  // list where it is buried under everyone else's. The toggle widens it.
  const [showAll, setShowAll] = useState(false);
  const [testScenario, setTestScenario] = useState<ArtifactoryScenario>(TEST_SCENARIOS[0].value);

  // Selecting a job puts it in the URL, so the link can be pasted to someone.
  useDeepLink("artifactory", selectedJobId, setSelectedJobId);

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

  // Only a running job changes on its own. Polling every 2s while the list is
  // idle re-sends every job's full log to every open tab for nothing.
  const anyRunning = jobs.some((j) => j.status === "pending" || j.status === "in-progress");

  useEffect(() => {
    const every = anyRunning ? 2000 : 15000;
    log("artifactory", `job poll every ${every}ms`);
    const id = setInterval(fetchJobs, every);
    return () => clearInterval(id);
  }, [anyRunning]);

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
        .catch((err: Error) => logError("artifactory", "getJob failed", err));
    fetchOpen();
    const id = setInterval(fetchOpen, anyRunning ? 2000 : 15000);
    return () => clearInterval(id);
  }, [selectedJobId, anyRunning]);

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

  // Fall back to the list row until the full job lands, so selecting a job
  // paints immediately and only the log arrives a tick later.
  const selectedJob =
    (openJob?.id === selectedJobId ? openJob : null) ?? jobs.find((j) => j.id === selectedJobId) ?? null;

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
            <h2>{isAdmin && showAll ? "All Jobs" : "My Jobs"}</h2>
            {isAdmin && (
              <button
                className="ghost-button"
                onClick={() => {
                  log("artifactory", `filter → ${showAll ? "my jobs" : "all jobs"}`);
                  setShowAll((v) => !v);
                }}
              >
                {/* Labels the action, not the state — the heading beside it
                    already says which list you're looking at. */}
                {showAll ? "My jobs" : "All jobs"}
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
                  <div className="tab-bar-action test-controls">
                    <select
                      className="test-scenario-select"
                      aria-label="Test scenario"
                      value={testScenario}
                      onChange={(e) => setTestScenario(e.target.value as ArtifactoryScenario)}
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
                        log("artifactory", "starting simulated run", testScenario);
                        simulateJob(testScenario)
                          .then((result) => handleSubmitted(result.job))
                          .catch((err: Error) => onError(err.message));
                      }}
                    >
                      <FlaskConical size={16} aria-hidden="true" /> Test
                    </button>
                  </div>
                )}
              </div>

              {/* Both forms stay mounted and the inactive one is hidden, the
                  same trick App.tsx uses for modules. Swapping them unmounted
                  the active form mid-upload, throwing away its scanned folder
                  and progress bar — which read as "switching tabs stops the
                  run" even though nothing was ever cancelled. */}
              <div className="tab-panel" hidden={activeTab !== "url-copy"}>
                <UrlCopyForm isAdmin={isAdmin} onSubmitted={handleSubmitted} onError={onError} />
              </div>
              <div className="tab-panel" hidden={activeTab !== "folder-upload"}>
                <FolderUploadForm onSubmitted={handleSubmitted} onError={onError} />
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
