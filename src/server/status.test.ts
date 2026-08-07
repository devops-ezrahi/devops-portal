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

  it("defaults unknown statuses to Submitted", () => {
    expect(mapInternalStatus("Needs CAB Review")).toBe("Submitted");
  });
});
