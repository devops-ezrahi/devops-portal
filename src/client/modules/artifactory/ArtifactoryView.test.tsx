import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactoryJob, PortalUser } from "../../../server/types";

const jobs: ArtifactoryJob[] = [
  {
    id: "ART-0001",
    kind: "folder-upload",
    status: "completed",
    submittedBy: "dev",
    submittedByName: "Dev User",
    createdAt: "2026-08-04T10:00:00.000Z",
    updatedAt: "2026-08-04T10:01:00.000Z",
    name: "node_modules (3 packages)",
    folderName: "node_modules",
    log: [],
  },
  {
    id: "ART-0002",
    kind: "url-copy",
    status: "completed",
    submittedBy: "u-alex",
    submittedByName: "Alex Morgan",
    createdAt: "2026-08-04T09:00:00.000Z",
    updatedAt: "2026-08-04T09:01:00.000Z",
    name: "arg@4.1.5",
    sourceUrl: "https://registry.npmjs.org/arg/-/arg-4.1.5.tgz",
    log: [],
  },
];

vi.mock("./api", () => ({ listJobs: () => Promise.resolve({ jobs }) }));

const { ArtifactoryView } = await import("./ArtifactoryView");

const user: PortalUser = { id: "dev", email: "dev@example.com", displayName: "Dev User", groups: [] };

function renderView(isAdmin: boolean) {
  return render(
    <ArtifactoryView user={user} isAdmin={isAdmin} refreshKey={0} onError={() => {}} />
  );
}

describe("ArtifactoryView job scope", () => {
  it("shows every submitter's job to an admin, with their name on the row", async () => {
    renderView(true);
    await waitFor(() => expect(screen.getByText("arg@4.1.5")).toBeInTheDocument());
    expect(screen.getByText("Alex Morgan")).toBeInTheDocument();
    expect(screen.getByText("Dev User")).toBeInTheDocument();
  });

  it("narrows to the admin's own jobs when the toggle is flipped", async () => {
    renderView(true);
    await waitFor(() => expect(screen.getByText("arg@4.1.5")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "All jobs" }));

    expect(screen.queryByText("arg@4.1.5")).not.toBeInTheDocument();
    expect(screen.getByText("node_modules (3 packages)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "My jobs" })).toBeInTheDocument();
  });

  it("gives non-admins no toggle at all", async () => {
    renderView(false);
    await waitFor(() => expect(screen.getByText("node_modules (3 packages)")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /jobs$/ })).not.toBeInTheDocument();
  });
});
