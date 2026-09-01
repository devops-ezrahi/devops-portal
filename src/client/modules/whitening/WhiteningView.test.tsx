import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PortalUser, WhiteningJob } from "../../../server/types";

const jobs: WhiteningJob[] = [
  {
    id: "WHT-0001",
    status: "completed",
    submittedBy: "dev",
    submittedByName: "Dev User",
    createdAt: "2026-08-04T10:00:00.000Z",
    updatedAt: "2026-08-04T10:01:00.000Z",
    archiveName: "portal-1.0.0.tgz",
    department: "dem",
    team: "devops",
    project: "portal",
    version: "1.0.0",
    log: [],
  },
  {
    id: "WHT-0002",
    status: "completed",
    submittedBy: "u-alex",
    submittedByName: "Alex Morgan",
    createdAt: "2026-08-04T09:00:00.000Z",
    updatedAt: "2026-08-04T09:01:00.000Z",
    archiveName: "checkout-2.3.0.tgz",
    department: "dem",
    team: "payments",
    project: "checkout",
    version: "2.3.0",
    log: [],
  },
];

vi.mock("./api", () => ({
  listJobs: () => Promise.resolve({ jobs }),
  cancelJob: () => Promise.resolve(),
  simulateJob: () => Promise.resolve(),
}));

const { WhiteningView } = await import("./WhiteningView");

const user: PortalUser = { id: "dev", email: "dev@example.com", displayName: "Dev User", groups: [] };

// Same contract as ArtifactoryView's toggle: the button names the list it
// switches TO. This one shipped inverted twice, so it's pinned here.
describe("WhiteningView job scope", () => {
  it("starts on the admin's own jobs and widens when the toggle is flipped", async () => {
    render(<WhiteningView user={user} isAdmin refreshKey={0} onError={() => {}} />);
    await waitFor(() => expect(screen.getByText("devops/portal")).toBeInTheDocument());
    expect(screen.queryByText("payments/checkout")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All jobs" }));

    expect(screen.getByText("payments/checkout")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "My jobs" })).toBeInTheDocument();
  });
});
