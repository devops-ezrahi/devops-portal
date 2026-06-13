import { describe, expect, it } from "vitest";
import { mapInternalStatus } from "./modules/ticketing/status";

describe("mapInternalStatus", () => {
  it("maps common internal and Jira statuses to customer stages", () => {
    expect(mapInternalStatus("New")).toBe("Submitted");
    expect(mapInternalStatus("Assigned")).toBe("Triaged");
    expect(mapInternalStatus("work_in_progress")).toBe("In Progress");
    expect(mapInternalStatus("Customer Action Required")).toBe("Waiting on Customer");
    expect(mapInternalStatus("Done")).toBe("Resolved");
    expect(mapInternalStatus("Cancelled")).toBe("Closed");
  });

  it("defaults unknown statuses to Triaged", () => {
    expect(mapInternalStatus("Needs CAB Review")).toBe("Triaged");
  });
});
