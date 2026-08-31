import { usernameFor } from "../../auth";
import { describeError, log } from "../../log";
import { getRequestType, validateRequestFields } from "./catalog";
import { parsePriority } from "./priority";
import { mapInternalStatus } from "./status";
import { canViewTicket } from "./visibility";
import type {
  AdminTicketFilters,
  AdminTicketUpdate,
  CreateTicketInput,
  CustomerStage,
  PortalUser,
  TicketComment,
  TicketDetail,
  TicketFilters,
  TicketSummary,
  TicketingApi
} from "../../types";

type JiraUser = {
  name?: string;
  key?: string;
  accountId?: string;
  displayName?: string;
  emailAddress?: string;
};

type JiraComment = {
  id?: string;
  author?: JiraUser;
  body?: string;
  created?: string;
};

type JiraIssue = {
  id?: string;
  key?: string;
  fields?: {
    summary?: string;
    description?: string;
    issuetype?: { name?: string };
    status?: { name?: string };
    priority?: { name?: string };
    reporter?: JiraUser;
    assignee?: JiraUser | null;
    labels?: string[];
    components?: Array<{ name?: string }>;
    created?: string;
    updated?: string;
    comment?: {
      comments?: JiraComment[];
    };
    /** Story points live under an instance-specific `customfield_*` key. */
    [customField: string]: unknown;
  };
};

type JiraSearchResponse = {
  issues?: JiraIssue[];
};

type JiraTransition = {
  id?: string;
  name?: string;
  to?: { name?: string };
};

type JiraTransitionsResponse = {
  transitions?: JiraTransition[];
};

type JiraSprint = {
  id: number;
  state?: string;
};

type JiraSprintsResponse = {
  values?: JiraSprint[];
};

export type JiraTicketingConfig = {
  baseUrl: string;
  token: string;
  projectKey: string;
  boardId: string;
  maintenanceIssueType: string;
  storyPointsField?: string;
  ticketLabel?: string;
};

/**
 * One shared Jira account writes every portal comment (see addComment), so the
 * portal author is carried in the body's first line instead. Readable in Jira's
 * own UI, and stripped again by `readPortalAuthor` before the portal shows it.
 */
function stampPortalAuthor(user: PortalUser, body: string): string {
  return `${user.displayName} (via DevOps Portal, ${user.id})\n\n${body}`;
}

const PORTAL_AUTHOR_RE = /^(.+?) \(via DevOps Portal, ([^)]*)\)\r?\n\r?\n([\s\S]*)$/;

/** The inverse. `null` for a comment written in Jira rather than the portal. */
function readPortalAuthor(body: string): { displayName: string; id: string; body: string } | null {
  const m = PORTAL_AUTHOR_RE.exec(body);
  return m ? { displayName: m[1], id: m[2], body: m[3] } : null;
}

function quoteJql(value: string) {
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

export class JiraTicketingApi implements TicketingApi {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly projectKey: string;
  private readonly boardId: string;
  private readonly maintenanceIssueType: string;
  private readonly storyPointsField: string;
  private readonly ticketLabel: string;
  /**
   * Portal ids Jira rejected as a `reporter` value. Portal identities come
   * from SSO and don't necessarily exist in Jira; once one is known bad,
   * "my tickets" queries as the JIRA_TOKEN account straight away instead of
   * failing and retrying on every poll.
   */
  private readonly unknownReporters = new Set<string>();

  constructor(config: JiraTicketingConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.token = config.token;
    this.projectKey = config.projectKey;
    this.boardId = config.boardId;
    this.maintenanceIssueType = config.maintenanceIssueType;
    this.storyPointsField = config.storyPointsField ?? "";
    this.ticketLabel = config.ticketLabel ?? "";
  }

  // Scopes every listing to one label so the portal can share a Jira project
  // with work it shouldn't show. Unset = no clause, i.e. the whole project.
  // createTicket applies the same label, or the portal would immediately lose
  // sight of the tickets it just made.
  private scopeClauses(): string[] {
    return this.ticketLabel ? [`labels = ${quoteJql(this.ticketLabel)}`] : [];
  }

  /** `undefined` when the field isn't configured or Jira has no value yet. */
  private storyPointsOf(fields: JiraIssue["fields"]): number | undefined {
    if (!this.storyPointsField) {
      return undefined;
    }
    const raw = fields?.[this.storyPointsField];
    return typeof raw === "number" ? raw : undefined;
  }

  private async fetchJson<T>(fullPath: string, options: RequestInit = {}): Promise<T> {
    const method = (options.method ?? "GET").toUpperCase();
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${fullPath}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(options.headers ?? {})
        }
      });
    } catch (cause) {
      log.error("jira", `${method} ${fullPath} unreachable`, cause, { ms: Date.now() - started, url: this.baseUrl });
      const reason = describeError(cause);
      throw new Error(`Jira request failed: could not reach ${this.baseUrl}${fullPath} (${reason})`);
    }

    const ms = Date.now() - started;
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      log.warn("jira", `${method} ${fullPath} ${response.status} ${response.statusText}`, {
        ms,
        body: body.trim().slice(0, 500) || undefined,
      });
      throw new Error(`Jira request failed: ${response.status} ${response.statusText} ${body}`.trim());
    }
    log.debug("jira", `${method} ${fullPath} ${response.status}`, { ms });

    const text = await response.text();
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      log.warn("jira", `${method} ${fullPath} returned non-JSON`, { ms, body: text.slice(0, 300) });
      throw new Error(
        `Jira request failed: ${fullPath} returned a non-JSON response (got "${text.slice(0, 120)}") — check JIRA_URL/JIRA_TOKEN`
      );
    }
  }

  private request<T>(path: string, options: RequestInit = {}): Promise<T> {
    return this.fetchJson<T>(`/rest/api/2${path}`, options);
  }

  private agileRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
    return this.fetchJson<T>(`/rest/agile/1.0${path}`, options);
  }

  private async getActiveSprintId(): Promise<number | null> {
    const result = await this.agileRequest<JiraSprintsResponse>(
      `/board/${encodeURIComponent(this.boardId)}/sprint?state=active`
    );
    return result.values?.[0]?.id ?? null;
  }

  /**
   * Jira identifies people by username; the portal identifies them by the id
   * its SSO proxy sends, which under Keycloak is a `sub` UUID. Everything
   * this class puts into a JQL clause or compares against a value Jira
   * returned goes through here first.
   */
  private jiraUser(user: PortalUser): PortalUser {
    return { ...user, id: usernameFor(user.id) };
  }

  private userId(user?: JiraUser | null): string {
    return user?.name ?? user?.key ?? user?.accountId ?? user?.emailAddress ?? "";
  }

  private userName(user?: JiraUser | null): string {
    return user?.displayName ?? this.userId(user);
  }

  private mapComment(comment: JiraComment): TicketComment {
    const stamped = readPortalAuthor(comment.body ?? "");
    return {
      id: comment.id ?? "",
      authorName: stamped?.displayName ?? this.userName(comment.author),
      authorId: stamped?.id || this.userId(comment.author),
      body: stamped?.body ?? comment.body ?? "",
      createdAt: comment.created ?? ""
    };
  }

  private mapSummary(issue: JiraIssue): TicketSummary {
    const fields = issue.fields ?? {};
    const rawStatus = fields.status?.name ?? "";
    const created = fields.created ?? "";
    const updated = fields.updated ?? created;
    const teamGroups = [
      ...(fields.components?.map((component) => component.name ?? "").filter(Boolean) ?? []),
      ...(fields.labels ?? [])
    ];

    return {
      id: issue.key ?? issue.id ?? "",
      title: fields.summary ?? "",
      requestType: fields.issuetype?.name ?? "",
      requesterId: this.userId(fields.reporter),
      requesterName: this.userName(fields.reporter),
      teamGroups,
      rawStatus,
      stage: mapInternalStatus(rawStatus),
      priority: parsePriority(fields.priority?.name),
      storyPoints: this.storyPointsOf(fields),
      respondedAt: (fields.comment?.comments ?? []).find(
        (comment) => this.userId(comment.author) !== this.userId(fields.reporter)
      )?.created,
      assigneeId: this.userId(fields.assignee),
      assigneeName: fields.assignee ? this.userName(fields.assignee) : "",
      createdAt: created,
      updatedAt: updated,
      lastActivityAt: updated
    };
  }

  private mapDetail(issue: JiraIssue): TicketDetail {
    const fields = issue.fields ?? {};
    return {
      ...this.mapSummary(issue),
      description: fields.description ?? "",
      comments: (fields.comment?.comments ?? []).map((comment) => this.mapComment(comment))
    };
  }

  private async search(jql: string): Promise<JiraIssue[]> {
    const result = await this.request<JiraSearchResponse>("/search", {
      method: "POST",
      // `comment` is not a navigable field, so it has to be asked for by name
      // or every summary comes back looking like nobody has replied.
      body: JSON.stringify({ jql, maxResults: 100, fields: ["*navigable", "comment"] })
    });
    return result.issues ?? [];
  }

  async createTicket(input: CreateTicketInput, requester: PortalUser): Promise<TicketDetail> {
    const requestType = getRequestType(input.requestType);
    if (!requestType) {
      throw new Error(`Unknown request type: ${input.requestType}`);
    }

    const fields = validateRequestFields(input.requestType, input.fields);

    if (input.idempotencyKey) {
      const existing = await this.search(`labels = ${quoteJql(input.idempotencyKey)}`);
      if (existing[0]) {
        return this.getAdminTicket(existing[0].key ?? existing[0].id ?? "") as Promise<TicketDetail>;
      }
    }

    const labels = [
      this.ticketLabel,
      requestType.ownerTeam,
      ...requester.groups,
      ...Object.entries(fields)
        .filter(([key]) => key !== "title" && key !== "description")
        .map(([key, value]) => `${key}:${String(value).replace(/\s+/g, "_")}`)
    ];
    if (input.idempotencyKey) {
      labels.push(input.idempotencyKey);
    }

    const created = await this.request<JiraIssue>("/issue", {
      method: "POST",
      body: JSON.stringify({
        fields: {
          project: { key: this.projectKey },
          // The issue type is a *Jira* fact, not a portal one. It used to be
          // the catalog's display name ("CI/CD Pipeline"), which no Jira
          // instance has, and Jira answers an unresolvable issuetype with
          // *both* "Could not find issuetype" and "project is required" — the
          // second error is a red herring. JIRA_MAINTENANCE_ISSUE_TYPE is the
          // type listAdminTickets already filters the admin queue on, so
          // creating anything else would also hide every new ticket from it.
          issuetype: { name: this.maintenanceIssueType || "Task" },
          priority: { name: input.priority },
          summary: fields.title ?? requestType.name,
          description: fields.description ?? "",
          labels: labels.filter(Boolean)
        }
      })
    });

    return this.getAdminTicket(created.key ?? created.id ?? "") as Promise<TicketDetail>;
  }

  async listTickets(user: PortalUser, filters: TicketFilters): Promise<TicketSummary[]> {
    const clauses: string[] = [`project = ${quoteJql(this.projectKey)}`, ...this.scopeClauses()];
    const jiraUser = this.jiraUser(user);
    const mineClause =
      filters.scope === "mine"
        ? `reporter = ${this.unknownReporters.has(jiraUser.id) ? "currentUser()" : quoteJql(jiraUser.id)}`
        : "";
    if (mineClause) {
      clauses.push(mineClause);
    }
    if (filters.status) {
      clauses.push(`status = ${quoteJql(filters.status)}`);
    }
    if (filters.query) {
      clauses.push(`(summary ~ ${quoteJql(filters.query)} OR description ~ ${quoteJql(filters.query)})`);
    }
    const jql = `${clauses.join(" AND ")} ORDER BY updated DESC`;
    let issues: JiraIssue[];
    try {
      issues = await this.search(jql);
    } catch (error) {
      // Jira rejects the whole query when `reporter` names a user it doesn't
      // have, so fall back to the account JIRA_TOKEN belongs to -- which is
      // who Jira recorded as the reporter of everything the portal filed.
      // ponytail: retried on any search failure rather than parsing Jira's
      // error text for the unknown-user case; a real outage just fails
      // again below, and only a *successful* retry marks the id bad.
      if (!mineClause || this.unknownReporters.has(jiraUser.id)) {
        throw error;
      }
      issues = await this.search(jql.replace(mineClause, "reporter = currentUser()"));
      this.unknownReporters.add(jiraUser.id);
      log.warn("jira", `reporter "${jiraUser.id}" is not a Jira user, listing as the JIRA_TOKEN account instead`);
    }
    const summaries = issues.map((issue) => this.mapSummary(issue));
    if (filters.scope === "team") {
      return summaries.filter((summary) => canViewTicket(jiraUser, summary));
    }
    return summaries;
  }

  async getTicket(ticketId: string, user: PortalUser): Promise<TicketDetail | null> {
    const issue = await this.request<JiraIssue>(`/issue/${encodeURIComponent(ticketId)}`);
    const detail = this.mapDetail(issue);
    if (!canViewTicket(this.jiraUser(user), detail)) {
      return null;
    }
    return detail;
  }

  async addComment(ticketId: string, user: PortalUser, body: string): Promise<TicketComment> {
    const comment = await this.request<JiraComment>(`/issue/${encodeURIComponent(ticketId)}/comment`, {
      method: "POST",
      // Real Jira resolves the comment author from whichever user's OAuth/PAT
      // made the request. This app authenticates with one shared service-level
      // token (JIRA_TOKEN) for every portal user, so Jira records *every*
      // portal comment as that one account -- which is why the thread read as
      // one person talking to themselves. The author is therefore written into
      // the body itself (`stampPortalAuthor`) and read back out on the way in
      // (`readPortalAuthor`); Jira's own users' comments carry no stamp and
      // keep the author Jira recorded.
      //
      // `author` stays as well: it is a jira-mock-only extension the mock
      // echoes back, and a real Jira Data Center ignores unknown JSON
      // properties on this endpoint.
      body: JSON.stringify({
        body: stampPortalAuthor(user, body),
        author: { name: user.id, displayName: user.displayName }
      })
    });
    return this.mapComment(comment);
  }

  async listAdminTickets(filters: AdminTicketFilters): Promise<TicketSummary[]> {
    const clauses: string[] = [`project = ${quoteJql(this.projectKey)}`, ...this.scopeClauses()];
    if (this.maintenanceIssueType) {
      clauses.push(`issuetype = ${quoteJql(this.maintenanceIssueType)}`);
    }
    if (this.boardId) {
      const sprintId = await this.getActiveSprintId();
      if (sprintId === null) {
        return [];
      }
      clauses.push(`sprint = ${sprintId}`);
    }
    if (filters.status) {
      clauses.push(`status = ${quoteJql(filters.status)}`);
    }
    if (filters.query) {
      clauses.push(`(summary ~ ${quoteJql(filters.query)} OR description ~ ${quoteJql(filters.query)})`);
    }
    const jql = `${clauses.join(" AND ")} ORDER BY updated DESC`;
    const issues = await this.search(jql);
    return issues.map((issue) => this.mapSummary(issue));
  }

  async getAdminTicket(ticketId: string): Promise<TicketDetail | null> {
    const issue = await this.request<JiraIssue>(`/issue/${encodeURIComponent(ticketId)}`);
    return this.mapDetail(issue);
  }

  async updateAdminTicket(ticketId: string, _admin: PortalUser, update: AdminTicketUpdate): Promise<TicketDetail> {
    const fields: Record<string, unknown> = {};
    if (update.title !== undefined) {
      fields.summary = update.title;
    }
    if (update.description !== undefined) {
      fields.description = update.description;
    }
    if (update.assigneeId !== undefined) {
      fields.assignee = update.assigneeId
        ? { name: usernameFor(update.assigneeId), displayName: update.assigneeName ?? update.assigneeId }
        : null;
    }
    if (update.teamGroups !== undefined) {
      fields.labels = update.teamGroups;
    }
    if (update.storyPoints !== undefined && this.storyPointsField) {
      fields[this.storyPointsField] = update.storyPoints;
    }

    if (Object.keys(fields).length > 0) {
      await this.request<void>(`/issue/${encodeURIComponent(ticketId)}`, {
        method: "PUT",
        body: JSON.stringify({ fields })
      });
    }

    if (update.stage !== undefined) {
      await this.transitionToStage(ticketId, update.stage);
    }

    return this.getAdminTicket(ticketId) as Promise<TicketDetail>;
  }

  async addAdminComment(ticketId: string, admin: PortalUser, body: string): Promise<TicketComment> {
    const comment = await this.request<JiraComment>(`/issue/${encodeURIComponent(ticketId)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body, author: { name: admin.id, displayName: admin.displayName } })
    });
    return this.mapComment(comment);
  }

  private async transitionToStage(ticketId: string, stage: CustomerStage): Promise<void> {
    const { transitions } = await this.request<JiraTransitionsResponse>(
      `/issue/${encodeURIComponent(ticketId)}/transitions`
    );
    const match = (transitions ?? []).find(
      (transition) => transition.to?.name && mapInternalStatus(transition.to.name) === stage
    );
    if (!match?.id) {
      throw new Error(`Jira request failed: no transition maps to stage "${stage}" for ${ticketId}`);
    }
    await this.request<void>(`/issue/${encodeURIComponent(ticketId)}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: match.id } })
    });
  }
}
