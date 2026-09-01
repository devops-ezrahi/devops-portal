import { Upload } from "lucide-react";
import { useState } from "react";
import { log, error as logError } from "../../../log";
import { submitUrlCopy } from "../api";
import type { ArtifactoryJob } from "../../../../server/types";

type Props = {
  onSubmitted: (job: ArtifactoryJob) => void;
  onError: (msg: string) => void;
};

export function UrlCopyForm({ onSubmitted, onError }: Props) {
  const [sourceUrl, setSourceUrl] = useState("");
  const [includeDependencies, setIncludeDependencies] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    log("artifactory/url-copy", "submitting", sourceUrl);
    try {
      const result = await submitUrlCopy({ sourceUrl, includeDependencies });
      log("artifactory/url-copy", "accepted", result.job.id, result.job.status);
      onSubmitted(result.job);
      setSourceUrl("");
      setIncludeDependencies(false);
    } catch (err) {
      logError("artifactory/url-copy", "submit failed", sourceUrl, err);
      onError(err instanceof Error ? err.message : "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="art-form" onSubmit={handleSubmit}>
      <div className="form-field">
        <label htmlFor="source-url">Package URL</label>
        <input
          id="source-url"
          type="url"
          required
          placeholder="https://repo1.maven.org/maven2/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
        />
        <span className="field-hint">
          URL of the artifact in the source repository, or the Artifactory page for it (the
          <code> /ui/repos/…</code> link from your address bar). The package type is detected from
          the file &mdash; .jar, .rpm, .whl and .conda each go to their own repo, and a .tgz is
          read to see whether it is an npm package or a Helm chart.
        </span>
      </div>

      <div className="form-field checkbox-field">
        <label htmlFor="include-deps">
          <input
            id="include-deps"
            type="checkbox"
            checked={includeDependencies}
            onChange={(e) => setIncludeDependencies(e.target.checked)}
          />
          Include dependencies <span className="field-note">(takes longer)</span>
        </label>
        <span className="field-hint">
          Resolves the full runtime tree for npm, Maven and PyPI and copies every artifact in it
          (PyPI is wheels only). A tree that won&rsquo;t resolve still copies the single artifact and
          says why in the job log. RPM, conda and Helm have no resolver &mdash; those copy the one
          artifact.
        </span>
      </div>

      <button type="submit" className="primary" disabled={submitting}>
        <Upload size={18} aria-hidden="true" />
        {submitting ? "Submitting..." : "Copy to Artifactory"}
      </button>
    </form>
  );
}
