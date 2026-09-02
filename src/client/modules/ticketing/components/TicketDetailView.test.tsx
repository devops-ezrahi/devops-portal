import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TicketDetailView } from "./TicketDetailView";
import type { TicketDetail } from "../../../../server/types";

function ticket(notice?: string): TicketDetail {
  return {
    id: "DEVOPS-9",
    title: "Pipeline for the billing service",
    requestType: "Maintenance",
    requesterId: "u-dana",
    requesterName: "Dana",
    teamGroups: [],
    rawStatus: "To Do",
    stage: "Submitted",
    priority: "Medium",
    assigneeId: "",
    assigneeName: "",
    createdAt: "2026-09-02T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
    lastActivityAt: "2026-09-02T10:00:00.000Z",
    description: "Please build one.",
    comments: [],
    notice,
  };
}

// A create that succeeded but did less than it was asked to — Jira refused the
// reporter, or there was no sprint to join. The ticket exists, so the server
// cannot report a failure, and the difference is invisible unless it is on the
// page: without this the only trace was a line in the pod log.
describe("TicketDetailView notice", () => {
  it("shows a create-time notice as a warning, without hiding the ticket", async () => {
    render(<TicketDetailView ticket={ticket("There is no active sprint on the board.")} onCommentAdded={async () => {}} />);

    expect(screen.getByText(/no active sprint/i)).toBeTruthy();
    expect(screen.getByText("Pipeline for the billing service")).toBeTruthy();
  });

  it("renders nothing extra when the create did everything it was asked to", async () => {
    const { container } = render(<TicketDetailView ticket={ticket()} onCommentAdded={async () => {}} />);

    expect(container.querySelector(".warn-banner")).toBeNull();
  });
});
