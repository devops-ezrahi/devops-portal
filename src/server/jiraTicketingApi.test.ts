import { afterEach, describe, expect, it, vi } from "vitest";
import { rememberUser } from "./auth";
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

  it("queries by the SSO username, not the proxy's subject id", async () => {
    // Keycloak's `sub` is a UUID; Jira has never heard of it and rejects the
    // whole query. The username claim is the handle it does know.
    const keycloakUser: PortalUser = {
      id: "8f1c-uuid",
      email: "dvora@example.com",
      displayName: "Dvora",
      groups: [],
      username: "dvora"
    };
    rememberUser(keycloakUser);

    const jql = await jqlOf(() => makeApi("").listTickets(keycloakUser, { scope: "mine" }));

    expect(jql).toContain(`reporter = "dvora"`);
    expect(jql).not.toContain("8f1c-uuid");
  });

  it("falls back to the JIRA_TOKEN account when Jira doesn't know the portal user", async () => {
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      const jql = JSON.parse(options!.body as string).jql as string;
      return jql.includes(`reporter = "jdoe"`)
        ? new Response(`{"errorMessages":["The reporter value 'jdoe' does not exist."]}`, { status: 400 })
        : jsonResponse({ issues: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = makeApi("");

    await api.listTickets(user, { scope: "mine" });

    const jqls = fetchMock.mock.calls.map(([, options]) => JSON.parse(options!.body as string).jql as string);
    expect(jqls).toHaveLength(2);
    expect(jqls[1]).toContain("reporter = currentUser()");

    // The rejected id is remembered, so the next poll doesn't pay for the
    // failed attempt again.
    await api.listTickets(user, { scope: "mine" });
    expect(fetchMock.mock.calls).toHaveLength(3);
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

describe("createTicket issue type", () => {
  const user: PortalUser = { id: "u-alex", email: "a@e.com", displayName: "Alex", groups: [] };

  it("creates as the configured Jira issue type, not the catalog's display name", async () => {
    const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => {
      if (url.includes("/issue/")) return jsonResponse({ key: "DEVOPS-1", fields: {} });
      return jsonResponse({ key: "DEVOPS-1", issues: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await makeApi("").createTicket(
      { requestType: "ci-cd-pipeline", priority: "Medium", fields: { title: "t", description: "d" } },
      user
    );

    const createCall = fetchMock.mock.calls.find(
      ([url, options]) => url.endsWith("/issue") && options?.method === "POST"
    );
    // "CI/CD Pipeline" is a portal catalog name; Jira answered it with
    // "Could not find issuetype by id or name" *and* "project is required".
    expect(JSON.parse(createCall![1]!.body as string).fields.issuetype).toEqual({ name: "Maintenance" });
  });
});

describe("createTicket files as the person on the page", () => {
  // An AD groups claim is a DN, so parseGroups hands back CNs with spaces in
  // them. Jira rejects the whole create over one such label, so nothing at all
  // got filed on those deployments.
  const dana: PortalUser = {
    id: "u-dana",
    email: "d@e.com",
    displayName: "Dana",
    groups: ["DevOps Admins", "platform"],
  };

  function createMock(reject?: (body: any) => boolean) {
    return vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/issue") && options?.method === "POST") {
        const body = JSON.parse((options.body as string) ?? "{}");
        if (reject?.(body)) return new Response(JSON.stringify({ errors: {} }), { status: 400 });
        return jsonResponse({ key: "DEVOPS-9" });
      }
      return jsonResponse({ key: "DEVOPS-9", fields: {} });
    });
  }

  const input = {
    requestType: "ci-cd-pipeline",
    fields: { title: "T", description: "D" },
    priority: "Medium" as const,
  };

  function createdFields(fetchMock: ReturnType<typeof vi.fn>, nth = 0) {
    const calls = fetchMock.mock.calls.filter(
      ([url, options]) => url.endsWith("/issue") && options?.method === "POST"
    );
    return JSON.parse(calls[nth]![1]!.body as string).fields;
  }

  it("sets the reporter to the portal user and never sends a label with a space", async () => {
    const fetchMock = createMock();
    vi.stubGlobal("fetch", fetchMock);

    await makeApi("").createTicket(input, dana);

    const fields = createdFields(fetchMock);
    expect(fields.reporter).toEqual({ name: "u-dana" });
    expect(fields.labels).toContain("DevOps_Admins");
    expect(fields.labels.some((l: string) => /\s/.test(l))).toBe(false);
  });

  // Jira 400s the whole create when the reporter is not one of its users, or
  // when the token's account may not set the field. A ticket filed as the
  // service account is worse than one filed as Dana, and better than none.
  it("retries without the reporter when Jira refuses it", async () => {
    const fetchMock = createMock((body) => Boolean(body.fields.reporter));
    vi.stubGlobal("fetch", fetchMock);

    const ticket = await makeApi("").createTicket(input, dana);

    expect(ticket.id).toBe("DEVOPS-9");
    expect(createdFields(fetchMock, 1).reporter).toBeUndefined();
  });
});

describe("comment authorship", () => {
  const alex: PortalUser = { id: "u-alex", email: "a@e.com", displayName: "Alex", groups: [] };

  it("round-trips the portal author through the body one shared Jira account writes", async () => {
    const posted: string[] = [];
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      const body = JSON.parse((options?.body as string) ?? "{}");
      posted.push(body.body);
      // What a real Jira echoes back: the service account, every time.
      return jsonResponse({ id: "1", body: body.body, author: { name: "svc-portal", displayName: "Portal Bot" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const comment = await makeApi("").addComment("DEVOPS-1", alex, "[status] needs input");

    expect(posted[0]).toBe("Alex (via DevOps Portal, u-alex)\n\n[status] needs input");
    expect(comment.authorName).toBe("Alex");
    expect(comment.authorId).toBe("u-alex");
    // The marker is stripped, so the client's own [status] prefix still leads.
    expect(comment.body).toBe("[status] needs input");
  });

  // The admin half of the same thread went out unstamped, so every reply came
  // back as the service account — one person talking to themselves again.
  it("stamps an admin reply with the admin who wrote it", async () => {
    const posted: string[] = [];
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      const body = JSON.parse((options?.body as string) ?? "{}");
      posted.push(body.body);
      return jsonResponse({ id: "1", body: body.body, author: { name: "svc-portal", displayName: "Portal Bot" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const comment = await makeApi("").addAdminComment("DEVOPS-1", alex, "[status] on it");

    expect(posted[0]).toBe("Alex (via DevOps Portal, u-alex)\n\n[status] on it");
    expect(comment.authorName).toBe("Alex");
    expect(comment.body).toBe("[status] on it");
  });

  it("leaves a comment written in Jira with the author Jira recorded", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        key: "DEVOPS-1",
        fields: { comment: { comments: [{ id: "2", body: "looking at it", author: { name: "dana", displayName: "Dana" } }] } }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const ticket = await makeApi("").getAdminTicket("DEVOPS-1");
    expect(ticket!.comments[0]).toMatchObject({ authorName: "Dana", authorId: "dana", body: "looking at it" });
  });
});
