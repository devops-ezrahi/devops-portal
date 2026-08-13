import { describe, expect, it, vi } from "vitest";

/** The IdP's `name` claim for a Hebrew-speaking user. */
const HEBREW_NAME = "דבי זהב";

/** What Node hands you when UTF-8 bytes are parsed as latin-1. */
const asLatin1 = (utf8: string) => Buffer.from(utf8, "utf8").toString("latin1");

async function loadAuth(ssoNameHeader: string) {
  vi.resetModules();
  vi.doMock("./config", () => ({
    config: { ssoNameHeader, adminGroups: ["portal-admins"], allowedGroups: [], ssoRequired: false, ssoUrl: "" },
  }));
  return import("./auth");
}

function reqWithHeaders(headers: Record<string, string>) {
  return { headers } as never;
}

describe("decodeHeaderText", () => {
  it("recovers a UTF-8 name that arrived parsed as latin-1", async () => {
    const { decodeHeaderText } = await loadAuth("");

    expect(asLatin1(HEBREW_NAME)).not.toBe(HEBREW_NAME); // precondition: it really is mangled
    expect(decodeHeaderText(asLatin1(HEBREW_NAME))).toBe(HEBREW_NAME);
  });

  it("leaves plain ASCII untouched", async () => {
    const { decodeHeaderText } = await loadAuth("");

    expect(decodeHeaderText("Alex Morgan")).toBe("Alex Morgan");
  });

  // Reinterpreting these bytes as UTF-8 yields replacement characters, so the
  // original is kept rather than mangled in the other direction.
  it("leaves a genuinely latin-1 name alone", async () => {
    const { decodeHeaderText } = await loadAuth("");

    expect(decodeHeaderText("Bjørn")).toBe("Bjørn");
  });
});

describe("SSO_NAME_HEADER", () => {
  it("prefers the configured header over preferred-username", async () => {
    const { userFromSsoHeaders } = await loadAuth("x-forwarded-name");

    const user = userFromSsoHeaders(
      reqWithHeaders({
        "x-forwarded-user": "dzahav",
        "x-forwarded-name": asLatin1(HEBREW_NAME),
        "x-forwarded-preferred-username": "dzahav",
      })
    );

    expect(user?.displayName).toBe(HEBREW_NAME);
  });

  it("falls back to preferred-username when the configured header is absent", async () => {
    const { userFromSsoHeaders } = await loadAuth("x-forwarded-name");

    const user = userFromSsoHeaders(
      reqWithHeaders({ "x-forwarded-user": "dzahav", "x-forwarded-preferred-username": "Dana Zahav" })
    );

    expect(user?.displayName).toBe("Dana Zahav");
  });

  it("keeps the previous behaviour when unset", async () => {
    const { userFromSsoHeaders } = await loadAuth("");

    const user = userFromSsoHeaders(
      reqWithHeaders({
        "x-forwarded-user": "dzahav",
        "x-forwarded-name": "ignored",
        "x-forwarded-preferred-username": "Dana Zahav",
      })
    );

    expect(user?.displayName).toBe("Dana Zahav");
  });
});
