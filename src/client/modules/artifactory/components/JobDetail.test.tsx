import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JobDetail } from "./JobDetail";
import type { ArtifactoryJob, PackageUploadResult } from "../../../../server/types";

function job(packages: PackageUploadResult[]): ArtifactoryJob {
  return {
    id: "ART-0001",
    kind: "url-copy",
    status: "completed",
    submittedBy: "dev",
    submittedByName: "Dev User",
    createdAt: "2026-08-31T10:00:00.000Z",
    updatedAt: "2026-08-31T10:01:00.000Z",
    packages,
    log: [],
  };
}

const jar: PackageUploadResult = {
  name: "org.apache.commons:commons-lang3",
  version: "3.12.0",
  path: "maven-local/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar",
  type: "maven",
  status: "uploaded",
  url: "https://art.example.com/jar",
};
const pom: PackageUploadResult = {
  ...jar,
  path: "maven-local/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.pom",
  url: "https://art.example.com/pom",
};

// A Maven copy uploads the jar and its pom under one set of coordinates. Two
// rows read as two different packages that happened to share a name.
describe("JobDetail package table", () => {
  it("folds a jar and its pom into one row", () => {
    render(<JobDetail job={job([jar, pom])} onStop={() => {}} />);

    expect(screen.getAllByText("org.apache.commons:commons-lang3@3.12.0")).toHaveLength(1);
    expect(screen.getByText("2 files")).toBeInTheDocument();
    // The link is the jar's, not the sidecar's.
    expect(screen.getByRole("link", { name: /commons-lang3@3\.12\.0/ })).toHaveAttribute(
      "href",
      "https://art.example.com/jar"
    );
  });

  it("takes the worst status in the group, so a failed pom is not hidden", () => {
    render(<JobDetail job={job([jar, { ...pom, status: "failed", error: "409 Conflict" }])} onStop={() => {}} />);

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.queryByText("Uploaded")).not.toBeInTheDocument();
    expect(screen.getByText("409 Conflict")).toBeInTheDocument();
  });

  it("keeps different packages apart", () => {
    const other = { ...jar, name: "com.google.guava:guava", version: "32.1.3-jre", path: "maven-local/g.jar" };
    render(<JobDetail job={job([jar, other])} onStop={() => {}} />);

    expect(document.querySelectorAll(".package-row")).toHaveLength(2);
    expect(screen.queryByText("2 files")).not.toBeInTheDocument();
  });
});

// The fallback keeps the job "Completed", so the drawer used to show
// "Dependencies: Included" over a copy of exactly one file.
describe("JobDetail dependency fallback", () => {
  it("says the tree was not copied, and why", () => {
    const fell = {
      ...job([jar]),
      includeDependencies: true,
      dependencyFallback: "maven is not installed in this image",
    };
    render(<JobDetail job={fell} onStop={() => {}} />);

    expect(screen.getByText(/Dependencies were not copied/)).toHaveTextContent(
      "maven is not installed in this image"
    );
    expect(screen.getByText("Requested, not copied")).toBeInTheDocument();
    // The badge has to say it too — the list is read without opening anything.
    expect(screen.getByText("Incomplete")).toBeInTheDocument();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
    expect(screen.queryByText("Included")).not.toBeInTheDocument();
  });

  it("still says Included when the tree came through", () => {
    render(<JobDetail job={{ ...job([jar]), includeDependencies: true }} onStop={() => {}} />);

    expect(screen.getByText("Included")).toBeInTheDocument();
    expect(document.querySelector(".warn-banner")).toBeNull();
  });
});
