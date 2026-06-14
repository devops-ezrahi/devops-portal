import { getRequestType, validateRequestFields } from "./catalog";
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
    reporter?: JiraUser;
    assignee?: JiraUser | null;
    labels?: string[];
    components?: Array<{ name?: string }>;
    created?: string;
    updated?: string;
    comment?: {
      comments?: JiraComment[];
    };
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

export type JiraTicketingConfig = {
  baseUrl: string;
  token: string;
  projectKey: string;
};

function quoteJql(value: string) {
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

export class JiraTicketingApi implements TicketingApi {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly projectKey: string;

  constructor(config: JiraTicketingConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.token = config.token;
    this.projectKey = config.projectKey;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}/rest/api/2${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Jira request failed: ${response.status} ${response.statusText} ${body}`.trim());
    }

    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private userId(user?: JiraUser | null): string {
    return user?.name ?? user?.key ?? user?.accountId ?? user?.emailAddress ?? "";
  }

  private userName(user?: JiraUser | null): string {
    return user?.displayName ?? this.userId(user);
  }

  private mapComment(comment: JiraComment): TicketComment {
    return {
      id: comment.id ?? "",
      authorName: this.userName(comment.author),
      authorId: this.userId(comment.author),
      body: comment.body ?? "",
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
      assigneeId: this.userId(fields.assignee),
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
      metadata: {},
      comments: (fields.comment?.comments ?? []).map((comment) => this.mapComment(comment))
    };
  }

  private async search(jql: string): Promise<JiraIssue[]> {
    const result = await this.request<JiraSearchResponse>("/search", {
      method: "POST",
      body: JSON.stringify({ jql, maxResults: 100 })
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
          issuetype: { name: requestType.name },
          summary: fields.title ?? requestType.name,
          description: fields.description ?? "",
          labels: labels.filter(Boolean)
        }
      })
    });

    return this.getAdminTicket(created.key ?? created.id ?? "") as Promise<TicketDetail>;
  }

  async listTickets(user: PortalUser, filters: TicketFilters): Promise<TicketSummary[]> {
    const clauses: string[] = [];
    if (filters.scope === "mine") {
      clauses.push(`reporter = ${quoteJql(user.id)}`);
    } else {
      clauses.push(`project = ${quoteJql(this.projectKey)}`);
    }
    if (filters.status) {
      clauses.push(`status = ${quoteJql(filters.status)}`);
    }
    if (filters.query) {
      clauses.push(`(summary ~ ${quoteJql(filters.query)} OR description ~ ${quoteJql(filters.query)})`);
    }
    const jql = `${clauses.join(" AND ")} ORDER BY updated DESC`;
    const issues = await this.search(jql);
    const summaries = issues.map((issue) => this.mapSummary(issue));
    if (filters.scope === "team") {
      return summaries.filter((summary) => canViewTicket(user, summary));
    }
    return summaries;
  }

  async getTicket(ticketId: string, user: PortalUser): Promise<TicketDetail | null> {
    const issue = await this.request<JiraIssue>(`/issue/${encodeURIComponent(ticketId)}`);
    const detail = this.mapDetail(issue);
    if (!canViewTicket(user, detail)) {
      return null;
    }
    return detail;
  }

  async addComment(ticketId: string, _user: PortalUser, body: string): Promise<TicketComment> {
    const comment = await this.request<JiraComment>(`/issue/${encodeURIComponent(ticketId)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body })
    });
    return this.mapComment(comment);
  }

  async listAdminTickets(filters: AdminTicketFilters): Promise<TicketSummary[]> {
    const clauses: string[] = [`project = ${quoteJql(this.projectKey)}`];
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
      fields.assignee = update.assigneeId ? { name: update.assigneeId } : null;
    }
    if (update.teamGroups !== undefined) {
      fields.labels = update.teamGroups;
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

  async addAdminComment(ticketId: string, _admin: PortalUser, body: string): Promise<TicketComment> {
    const comment = await this.request<JiraComment>(`/issue/${encodeURIComponent(ticketId)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body })
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
