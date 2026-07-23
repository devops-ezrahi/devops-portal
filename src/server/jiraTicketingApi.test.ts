import { afterEach, describe, expect, it, vi } from "vitest";
import { JiraTicketingApi } from "./modules/ticketing/JiraTicketingApi";
import type { PortalUser } from "./types";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function makeApi(boardId: string) {
  return new JiraTicketingApi({
    baseUrl: "https://jira.example.com",
    token: "token",
    projectKey: "DEVOPS",
    boardId,
    maintenanceIssueType: "Maintenance"
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("JiraTicketingApi.listAdminTickets", () => {
  it("filters by maintenance issue type and the board's active sprint", async () => {
    const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => {
      if (url.includes("/rest/agile/1.0/board/42/sprint")) {
        return jsonResponse({ values: [{ id: 7, state: "active" }] });
      }
      return jsonResponse({ issues: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await makeApi("42").listAdminTickets({});

    const searchCall = fetchMock.mock.calls.find(([url]) => url.includes("/search"));
    const jql = JSON.parse(searchCall![1]!.body as string).jql as string;
    expect(jql).toContain(`issuetype = "Maintenance"`);
    expect(jql).toContain("sprint = 7");
  });

  it("returns no tickets without querying search when no sprint is active", async () => {
    const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => {
      if (url.includes("/rest/agile/1.0/board/42/sprint")) {
        return jsonResponse({ values: [] });
      }
      return jsonResponse({ issues: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tickets = await makeApi("42").listAdminTickets({});

    expect(tickets).toEqual([]);
    expect(fetchMock.mock.calls.some(([url]) => url.includes("/search"))).toBe(false);
  });

  it("omits the sprint clause when no board is configured", async () => {
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => jsonResponse({ issues: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await makeApi("").listAdminTickets({});

    const searchCall = fetchMock.mock.calls.find(([url]) => url.includes("/search"));
    const jql = JSON.parse(searchCall![1]!.body as string).jql as string;
    expect(jql).not.toContain("sprint");
  });
});

describe("JiraTicketingApi.listTickets", () => {
  const user: PortalUser = { id: "jdoe", email: "jdoe@example.com", displayName: "J Doe", groups: [] };

  it("scopes 'mine' to this project, not every project the user has reported in", async () => {
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => jsonResponse({ issues: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await makeApi("").listTickets(user, { scope: "mine" });

    const searchCall = fetchMock.mock.calls.find(([url]) => url.includes("/search"));
    const jql = JSON.parse(searchCall![1]!.body as string).jql as string;
    expect(jql).toContain(`project = "DEVOPS"`);
    expect(jql).toContain(`reporter = "jdoe"`);
  });
});
