import { describe, expect, it } from "vitest";
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
