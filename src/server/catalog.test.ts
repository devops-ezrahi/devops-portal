import { describe, expect, it } from "vitest";
import { validateRequestFields } from "./modules/ticketing/catalog";

describe("validateRequestFields", () => {
  it("accepts the catalog's fields", () => {
    const fields = validateRequestFields("ci-cd-pipeline", {
      title: "Add production gate",
      description: "Need a manual approval gate"
    });

    expect(fields).toEqual({ title: "Add production gate", description: "Need a manual approval gate" });
  });

  it("rejects a blank required field", () => {
    expect(() => validateRequestFields("ci-cd-pipeline", { title: "  ", description: "x" })).toThrow();
  });

  it("rejects an unknown request type", () => {
    expect(() => validateRequestFields("incident-support", { title: "x", description: "y" })).toThrow(
      /Unknown request type/
    );
  });
});
