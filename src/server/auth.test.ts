import { afterEach, describe, expect, it, vi } from "vitest";
import { userFromSsoHeaders } from "./auth";

function reqWithHeaders(headers: Record<string, string>) {
  return { headers } as unknown as Parameters<typeof userFromSsoHeaders>[0];
}

describe("userFromSsoHeaders groups parsing", () => {
  it("splits plain comma-separated groups", () => {
    const user = userFromSsoHeaders(
      reqWithHeaders({ "x-forwarded-user": "alice", "x-forwarded-groups": "devops-admins,devops-platform" }),
    );
    expect(user?.groups).toEqual(["devops-admins", "devops-platform"]);
  });

  it("extracts CN from a single LDAP-DN group", () => {
    const user = userFromSsoHeaders(
      reqWithHeaders({
        "x-forwarded-user": "alice",
        "x-forwarded-groups": "CN=devops-admins,OU=Groups,DC=corp,DC=local",
      }),
    );
    expect(user?.groups).toEqual(["devops-admins"]);
  });

  it("extracts CN from multiple comma-joined LDAP-DN groups without cross-contamination", () => {
    const user = userFromSsoHeaders(
      reqWithHeaders({
        "x-forwarded-user": "alice",
        "x-forwarded-groups":
          "CN=devops-admins,OU=Groups,DC=corp,DC=local,CN=devops-viewers,OU=Groups,DC=corp,DC=local",
      }),
    );
    expect(user?.groups).toEqual(["devops-admins", "devops-viewers"]);
  });
});

describe("requireSession admin bypass of ALLOWED_GROUPS", () => {
  afterEach(() => {
    delete process.env.ADMIN_GROUP;
    delete process.env.ALLOWED_GROUPS;
  });

  async function callRequireSession(groupsHeader: string) {
    vi.resetModules();
    const { requireSession } = await import("./auth");
    const req = { headers: { "x-forwarded-user": "alice", "x-forwarded-groups": groupsHeader } } as any;
    let statusCode: number | undefined;
    const res = { status(code: number) { statusCode = code; return this; }, json() {} } as any;
    let nextCalled = false;
    await requireSession(req, res, () => {
      nextCalled = true;
    });
    return { statusCode, nextCalled };
  }

  it("lets an admin through even when their group isn't in ALLOWED_GROUPS", async () => {
    process.env.ADMIN_GROUP = "devops-admins";
    process.env.ALLOWED_GROUPS = "devops-platform";
    const { statusCode, nextCalled } = await callRequireSession("devops-admins");
    expect(nextCalled).toBe(true);
    expect(statusCode).toBeUndefined();
  });

  it("still denies a non-admin whose group isn't in ALLOWED_GROUPS", async () => {
    process.env.ADMIN_GROUP = "devops-admins";
    process.env.ALLOWED_GROUPS = "devops-platform";
    const { statusCode, nextCalled } = await callRequireSession("some-other-group");
    expect(nextCalled).toBe(false);
    expect(statusCode).toBe(403);
  });
});
