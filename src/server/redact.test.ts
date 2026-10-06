import { describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({
  config: { git: { token: "git-secret" }, artifactory: { token: "art-secret" }, ai: { apiKey: "ai-secret" } },
}));

const { redactSecrets } = await import("./redact");

describe("redactSecrets", () => {
  it("masks credentials embedded in a clone URL", () => {
    expect(redactSecrets("$ git clone https://oauth2:git-secret@git.example.com/scm/dem/app.git")).toBe(
      "$ git clone https://oauth2:***@git.example.com/scm/dem/app.git"
    );
  });

  it("masks a token passed as a CLI flag", () => {
    expect(redactSecrets("$ skopeo copy --dest-creds art-secret:art-secret docker://x")).toBe(
      "$ skopeo copy --dest-creds ***:*** docker://x"
    );
  });

  it("leaves clean lines alone", () => {
    expect(redactSecrets("Uploading 3 files")).toBe("Uploading 3 files");
  });
});
