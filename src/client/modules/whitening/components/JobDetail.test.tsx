import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JobDetail } from "./JobDetail";
import type { WhiteningJob } from "../../../../server/types";

function makeJob(overrides: Partial<WhiteningJob> = {}): WhiteningJob {
  return {
    id: "WHT-0001",
    status: "completed",
    submittedBy: "u1",
    submittedByName: "Tester",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    archiveName: "dem-devops-portal-1.0.0.tgz",
    department: "ultra",
    team: "dem",
    project: "devops-portal",
    version: "1.0.0",
    log: [
      { step: "Clone", line: "$ git clone ..." },
      { step: "Clone", line: "Cloning into 'repo'..." },
      { step: "Pull request", line: "Opening PR against main ..." },
    ],
    ...overrides,
  };
}

describe("whitening JobDetail log", () => {
  it("collapses consecutive lines from the same step into one group", () => {
    render(<JobDetail job={makeJob()} />);

    const groups = document.querySelectorAll("details.job-log-step");
    expect(groups).toHaveLength(2);
    expect(screen.getByText("Clone")).toBeInTheDocument();
    expect(screen.getByText("Pull request")).toBeInTheDocument();
    // Line count badge for the two-line Clone step.
    expect(screen.getAllByText("2")[0]).toBeInTheDocument();
  });

  it("keeps every line, in order, inside its step", () => {
    render(<JobDetail job={makeJob()} />);
    const bodies = [...document.querySelectorAll("pre.job-log-body")].map((el) => el.textContent);
    expect(bodies[0]).toBe("$ git clone ...\nCloning into 'repo'...");
    expect(bodies[1]).toBe("Opening PR against main ...");
  });

  it("leaves the last step open while the job is still running, closed once completed", () => {
    const { unmount } = render(<JobDetail job={makeJob({ status: "in-progress" })} />);
    let groups = [...document.querySelectorAll("details.job-log-step")];
    expect(groups.map((g) => (g as HTMLDetailsElement).open)).toEqual([false, true]);
    unmount();

    render(<JobDetail job={makeJob({ status: "completed" })} />);
    groups = [...document.querySelectorAll("details.job-log-step")];
    expect(groups.every((g) => !(g as HTMLDetailsElement).open)).toBe(true);
  });

  it("opens the failing step so the error is visible without a click", () => {
    render(<JobDetail job={makeJob({ status: "failed", errorMessage: "boom" })} />);
    const groups = [...document.querySelectorAll("details.job-log-step")] as HTMLDetailsElement[];
    expect(groups[groups.length - 1].open).toBe(true);
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("shows the empty state rather than an empty group list", () => {
    render(<JobDetail job={makeJob({ log: [] })} />);
    expect(screen.getByText("No log entries yet.")).toBeInTheDocument();
    expect(document.querySelectorAll("details.job-log-step")).toHaveLength(0);
  });
});
