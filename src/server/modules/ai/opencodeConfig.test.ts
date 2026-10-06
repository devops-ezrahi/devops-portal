import { readFileSync } from "fs";
import { describe, expect, it, vi } from "vitest";

/**
 * The generated opencode config is the only channel for two things opencode
 * offers no env var for: the read-only permission deny-list, and the provider
 * base URL. Both are written at import time, so each case needs its own module
 * registry.
 */
async function loadWithConfig(ai: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock("../../config", () => ({
    config: {
      artifactory: { url: "", repo: "", npmRepo: "", token: "" },
      git: { url: "", token: "", username: "" },
      ai: { projects: {}, apiKey: "", model: "anthropic/claude-sonnet-5", baseUrl: "", ...ai },
    },
  }));
  await import("./RealAiApi");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  return JSON.parse(readFileSync(join(tmpdir(), "ai-opencode", "opencode.json"), "utf8"));
}

describe("generated opencode config", () => {
  it("always carries the read-only deny-list", async () => {
    const written = await loadWithConfig({});

    expect(written.permission.edit).toBe("deny");
    expect(written.permission.bash).toBe("deny");
    expect(written.permission.read).toBe("allow");
  });

  it("omits a provider block when OPENCODE_BASE_URL is unset", async () => {
    const written = await loadWithConfig({});

    expect(written.provider).toBeUndefined();
  });

  // provider.<id>.options.baseURL is opencode's own schema (verified against
  // https://opencode.ai/config.json); <id> comes from the model string.
  it("points the model's provider at OPENCODE_BASE_URL, keeping the deny-list", async () => {
    const written = await loadWithConfig({
      model: "openai/gpt-4o",
      baseUrl: "https://gateway.internal/v1",
    });

    expect(written.provider).toEqual({
      openai: { options: { baseURL: "https://gateway.internal/v1" } },
    });
    expect(written.permission.edit).toBe("deny");
  });
});
