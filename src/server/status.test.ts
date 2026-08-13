import { describe, expect, it } from "vitest";
import { mapInternalStatus } from "./modules/ticketing/status";

describe("mapInternalStatus", () => {
  it("maps common internal and Jira statuses to customer stages", () => {
    expect(mapInternalStatus("New")).toBe("Submitted");
    expect(mapInternalStatus("Assigned")).toBe("Submitted");
    expect(mapInternalStatus("work_in_progress")).toBe("In Progress");
    expect(mapInternalStatus("Customer Action Required")).toBe("Waiting on Customer");
    expect(mapInternalStatus("Done")).toBe("Closed");
    expect(mapInternalStatus("Resolved")).toBe("Closed");
  });

  it("gives cancellation its own stage rather than folding it into Closed", () => {
    expect(mapInternalStatus("Cancelled")).toBe("Cancelled");
    expect(mapInternalStatus("canceled")).toBe("Cancelled");
  });

  // Both of these used to fall through to the "Submitted" default, which broke
  // the write path too: transitionToStage matches a Jira transition by mapping
  // its target name, so an unmapped status means "no transition maps to that
  // stage" and the stage dropdown silently reverted.
  it("maps this instance's Stuck and Pull Request statuses", () => {
    expect(mapInternalStatus("Stuck")).toBe("Waiting on Customer");
    expect(mapInternalStatus("Pull Request")).toBe("In Review");
    expect(mapInternalStatus("pull_request")).toBe("In Review");
  });

  it("defaults unknown statuses to Submitted", () => {
    expect(mapInternalStatus("Needs CAB Review")).toBe("Submitted");
  });
});
