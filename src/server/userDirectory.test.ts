import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

/** A fresh `auth` module, which is what a new pod starts with. */
async function freshAuth() {
  vi.resetModules();
  return import("./auth");
}

const admin = { id: "sub-1", username: "dana", email: "d@x.io", displayName: "Dana Levi", groups: ["portal-admins"] };

describe("the user directory survives a restart", () => {
  it("lists an admin seen by a previous process as an assignee", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "users-"));

    const before = await freshAuth();
    before.loadKnownUsers(dataDir);
    before.rememberUser(admin);
    expect(before.listAdminCandidates()).toEqual([{ id: "sub-1", displayName: "Dana Levi" }]);
    // The write is queued; give it the tick it needs before "restarting".
    await vi.waitFor(async () => {
      const after = await freshAuth();
      after.loadKnownUsers(dataDir);
      expect(after.listAdminCandidates()).toEqual([{ id: "sub-1", displayName: "Dana Levi" }]);
      expect(after.usernameFor("sub-1")).toBe("dana");
    });
  });

  it("starts empty, rather than failing to boot, on a first run", async () => {
    const auth = await freshAuth();
    auth.loadKnownUsers(mkdtempSync(join(tmpdir(), "users-")));
    expect(auth.listAdminCandidates()).toEqual([]);
  });
});
