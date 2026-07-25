import { Upload } from "lucide-react";
import { useState } from "react";
import { submitUrlCopy } from "../api";
import type { ArtifactoryJob } from "../../../../server/types";

type Props = {
  onSubmitted: (job: ArtifactoryJob) => void;
  onError: (msg: string) => void;
};

export function UrlCopyForm({ onSubmitted, onError }: Props) {
  const [sourceUrl, setSourceUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const result = await submitUrlCopy({ sourceUrl });
      onSubmitted(result.job);
      setSourceUrl("");
    } catch (err) {
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
          placeholder="https://artifactory.example.com/artifactory/my-repo/lodash/-/lodash-4.17.21.tgz"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
        />
        <span className="field-hint">URL of the artifact in the source Artifactory repository</span>
      </div>

      <button type="submit" className="primary" disabled={submitting}>
        <Upload size={18} aria-hidden="true" />
        {submitting ? "Submitting..." : "Copy to Artifactory"}
      </button>
    </form>
  );
}
