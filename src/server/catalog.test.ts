import { describe, expect, it } from "vitest";
import { validateRequestFields } from "./modules/ticketing/catalog";

describe("validateRequestFields", () => {
  it("accepts request-type-specific fields", () => {
    const fields = validateRequestFields("ci-cd-pipeline", {
      title: "Add production gate",
      application: "payments",
      repository: "https://git.example.com/payments",
      environment: "Production",
      description: "Need a manual approval gate"
    });

    expect(fields.environment).toBe("Production");
  });

  it("rejects invalid catalog options", () => {
    expect(() =>
      validateRequestFields("incident-support", {
        title: "Broken deployment",
        severity: "Emergency",
        system: "worker",
        description: "Deployment failed"
      })
    ).toThrow();
  });
});
