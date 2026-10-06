import { describe, expect, it } from "vitest";
import { hasTemplate, resolveTemplate, templateParts } from "./templates";

const scopes = [
  { folder: "dev/black", values: { color: "black", environment: "dev" } },
  { folder: "prd/yellow", values: { color: "yellow" } },
];

describe("templates", () => {
  it("resolves .Values and .Release.Namespace per folder", () => {
    expect(resolveTemplate("api.{{ .Release.Namespace }}.{{ .Values.color }}.org", scopes)).toEqual([
      { folder: "dev/black", text: "api.dev.black.org" },
      { folder: "prd/yellow", text: "api.prd.yellow.org" },
    ]);
  });

  it("names the placeholder a folder leaves unset", () => {
    expect(resolveTemplate("{{ .Values.environment }}", scopes)[1]).toEqual({
      folder: "prd/yellow",
      missing: ".Values.environment",
    });
  });

  it("splits text into plain runs and placeholders", () => {
    expect(templateParts("certs-{{ .Values.color }}")).toEqual(["certs-", { ref: "Values.color" }]);
    expect(hasTemplate("plain")).toBe(false);
    expect(hasTemplate('{{ "{{" }} escaped')).toBe(false);
  });
});
