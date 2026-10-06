import { describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({
  config: {
    logLevel: "info",
    git: { token: "git-secret" },
    artifactory: { token: "" },
    ai: { apiKey: "" },
  },
}));

const { describeError, log, userMessage } = await import("./log");

describe("describeError", () => {
  it("walks the cause chain fetch buries the real reason in", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), { code: "ECONNREFUSED" });
    const err = new TypeError("fetch failed", { cause });
    expect(describeError(err)).toBe(
      "TypeError: fetch failed <- caused by Error: connect ECONNREFUSED 10.0.0.1:443 (ECONNREFUSED)"
    );
  });

  it("does not loop forever on a self-referencing cause", () => {
    const err = new Error("round");
    (err as { cause?: unknown }).cause = err;
    expect(describeError(err)).toBe("Error: round");
  });
});

describe("userMessage", () => {
  it("puts the buried reason next to the useless top-level message", () => {
    const err = new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND art.example.com") });
    expect(userMessage(err)).toBe("fetch failed (getaddrinfo ENOTFOUND art.example.com)");
  });

  it("leaves a plain error's message alone", () => {
    expect(userMessage(new Error("Archive is missing repository/config.json"))).toBe(
      "Archive is missing repository/config.json"
    );
  });
});

describe("log", () => {
  it("emits one redacted line with its fields, skipping empty ones", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log.info("artifactory", "cloning with git-secret", { ms: 12, blank: "", missing: undefined });
    const line = spy.mock.calls[0][0] as string;
    spy.mockRestore();

    expect(line).toContain("INFO  [artifactory] cloning with ***");
    expect(line).toContain(" ms=12");
    expect(line).not.toContain("blank");
    expect(line).not.toContain("missing");
  });

  it("drops debug lines below the configured level", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log.debug("http", "GET /api/artifactory/jobs 200");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
