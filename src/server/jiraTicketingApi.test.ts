import { afterEach, describe, expect, it, vi } from "vitest";
import { JiraTicketingApi } from "./modules/ticketing/JiraTicketingApi";
import type { PortalUser } from "./types";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function makeApi(boardId: string, ticketLabel = "") {
  return new JiraTicketingApi({
    baseUrl: "https://jira.example.com",
    token: "token",
    projectKey: "DEVOPS",
    boardId,
    maintenanceIssueType: "Maintenance",
    ticketLabel
  });
}

async function jqlOf(run: (fetchMock: ReturnType<typeof vi.fn>) => Promise<unknown>) {
  const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => jsonResponse({ issues: [] }));
  vi.stubGlobal("fetch", fetchMock);
  await run(fetchMock);
  const searchCall = fetchMock.mock.calls.find(([url]) => url.includes("/search"));
  return JSON.parse(searchCall![1]!.body as string).jql as string;
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

describe("JIRA_TICKET_LABEL scoping", () => {
  const user: PortalUser = { id: "jdoe", email: "jdoe@example.com", displayName: "J Doe", groups: [] };

  it("adds the label clause to both the customer list and the admin queue", async () => {
    const customerJql = await jqlOf(() => makeApi("", "portal").listTickets(user, { scope: "mine" }));
    const adminJql = await jqlOf(() => makeApi("", "portal").listAdminTickets({}));

    expect(customerJql).toContain(`labels = "portal"`);
    expect(adminJql).toContain(`labels = "portal"`);
  });

  it("adds no clause when unset, leaving the whole project in scope", async () => {
    const jql = await jqlOf(() => makeApi("").listTickets(user, { scope: "mine" }));

    expect(jql).not.toContain("labels");
  });

  it("tags created tickets with the label, or the portal loses sight of them", async () => {
    const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => {
      if (url.includes("/issue/")) return jsonResponse({ key: "DEVOPS-1", fields: {} });
      return jsonResponse({ key: "DEVOPS-1", issues: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await makeApi("", "portal").createTicket(
      {
        requestType: "ci-cd-pipeline",
        priority: "Medium",
        fields: {
          title: "t",
          application: "app",
          repository: "https://git.example.com/app.git",
          environment: "Development",
          description: "d"
        }
      },
      user
    );

    const createCall = fetchMock.mock.calls.find(
      ([url, options]) => url.endsWith("/issue") && options?.method === "POST"
    );
    expect(JSON.parse(createCall![1]!.body as string).fields.labels).toContain("portal");
  });
});
