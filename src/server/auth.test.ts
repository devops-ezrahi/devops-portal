import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeJwtPayload, displayNameFor, rememberUser, userFromSsoHeaders } from "./auth";

function reqWithHeaders(headers: Record<string, string>) {
  return { headers } as unknown as Parameters<typeof userFromSsoHeaders>[0];
}

function jwt(payload: Record<string, unknown>) {
  const b64url = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(payload)}.sig`;
}

describe("decodeJwtPayload", () => {
  it("extracts claims from a well-formed token without verifying the signature", () => {
    expect(decodeJwtPayload(jwt({ name: "דבי גולד", sub: "abc" }))).toEqual({ name: "דבי גולד", sub: "abc" });
  });

  it("handles base64url characters (-/_) that plain base64 would mishandle", () => {
    // This payload's standard base64 is "eyJub3RlIjoiPj4+Pz8/Ly8vKysrIn0="
    // (contains both '+' and '/') — jwt() url-safe-encodes it to '-'/'_',
    // and decodeJwtPayload must translate those back before decoding.
    const payload = { note: ">>>???///+++" };
    expect(decodeJwtPayload(jwt(payload))).toEqual(payload);
  });

  it("returns {} for a malformed token instead of throwing", () => {
    expect(decodeJwtPayload("not-a-jwt")).toEqual({});
    expect(decodeJwtPayload("")).toEqual({});
    expect(decodeJwtPayload("a.b")).toEqual({});
  });

  it("returns {} when the payload segment isn't valid JSON", () => {
    expect(decodeJwtPayload("header.bm90LWpzb24.sig")).toEqual({});
  });
});

describe("userFromSsoHeaders access-token name claim", () => {
  it("prefers the JWT's name claim over header-based fallbacks", () => {
    const user = userFromSsoHeaders(
      reqWithHeaders({
        "x-forwarded-user": "sub-123",
        "x-forwarded-access-token": jwt({ name: "דבי גולד" }),
        "x-forwarded-preferred-username": "dvora",
      }),
    );
    expect(user?.displayName).toBe("דבי גולד");
  });

  it("falls back to header-based resolution when no access token is forwarded", () => {
    const user = userFromSsoHeaders(
      reqWithHeaders({ "x-forwarded-user": "sub-123", "x-forwarded-preferred-username": "dvora" }),
    );
    expect(user?.displayName).toBe("dvora");
  });

  it("falls back to header-based resolution when the token has no name claim", () => {
    const user = userFromSsoHeaders(
      reqWithHeaders({
        "x-forwarded-user": "sub-123",
        "x-forwarded-access-token": jwt({ sub: "sub-123" }),
        "x-forwarded-preferred-username": "dvora",
      }),
    );
    expect(user?.displayName).toBe("dvora");
  });

  it("falls back to header-based resolution when the token is malformed", () => {
    const user = userFromSsoHeaders(
      reqWithHeaders({
        "x-forwarded-user": "sub-123",
        "x-forwarded-access-token": "garbage",
        "x-forwarded-preferred-username": "dvora",
      }),
    );
    expect(user?.displayName).toBe("dvora");
  });
});

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

describe("displayNameFor", () => {
  const sub = "b4f2c1a0-0000-4000-8000-000000000001";

  it("prefers the directory over a stored snapshot", () => {
    rememberUser({ id: sub, email: "shugi@example.com", displayName: "shugi", groups: [] });
    expect(displayNameFor(sub, "old-name")).toBe("shugi");
  });

  it("never leaks a raw id when the stored name is empty", () => {
    rememberUser({ id: sub, email: "shugi@example.com", displayName: "shugi", groups: [] });
    expect(displayNameFor(sub, "")).toBe("shugi");
  });

  it("falls back to the snapshot, then the id, for an unknown user", () => {
    expect(displayNameFor("never-seen", "Snapshot Name")).toBe("Snapshot Name");
    expect(displayNameFor("never-seen", "")).toBe("never-seen");
  });

  it("leaves an unassigned ticket's empty name alone", () => {
    expect(displayNameFor("", "")).toBe("");
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
