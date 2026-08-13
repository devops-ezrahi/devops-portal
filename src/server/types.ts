export type CustomerStage =
  | "Submitted"
  | "In Progress"
  | "In Review"
  | "Waiting on Customer"
  | "Closed"
  | "Cancelled";

export type TicketScope = "mine" | "team";

/** Jira's default priority scheme — sent as `fields.priority.name` verbatim. */
export type TicketPriority = "Highest" | "High" | "Medium" | "Low" | "Lowest";

export type PortalUser = {
  id: string;
  email: string;
  displayName: string;
  groups: string[];
};

export type TicketComment = {
  id: string;
  authorName: string;
  authorId: string;
  body: string;
  createdAt: string;
};

export type TicketSummary = {
  id: string;
  title: string;
  requestType: string;
  requesterId: string;
  requesterName: string;
  teamGroups: string[];
  rawStatus: string;
  stage: CustomerStage;
  priority: TicketPriority;
  /** Admin-set effort estimate; required before a ticket can be Closed. */
  storyPoints?: number;
  /**
   * When the team first replied — the moment the response-time promise is
   * met. Derived from comments, so the queue can stop the SLA clock without
   * loading each ticket's full detail.
   */
  respondedAt?: string;
  assigneeId: string;
  assigneeName: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
};

export type TicketDetail = TicketSummary & {
  description: string;
  metadata: Record<string, string>;
  comments: TicketComment[];
};

export type RequestFieldDefinition = {
  name: string;
  label: string;
  type: "text" | "textarea" | "select";
  required: boolean;
  options?: string[];
};

export type RequestTypeDefinition = {
  id: string;
  name: string;
  description: string;
  ownerTeam: string;
  fields: RequestFieldDefinition[];
};

export type TicketFilters = {
  scope: TicketScope;
  status?: CustomerStage;
  query?: string;
};

export type AdminTicketFilters = {
  status?: CustomerStage;
  query?: string;
};

export type CreateTicketInput = {
  requestType: string;
  priority: TicketPriority;
  fields: Record<string, string>;
  idempotencyKey?: string;
};

export type AdminTicketUpdate = {
  stage?: CustomerStage;
  storyPoints?: number;
  rawStatus?: string;
  title?: string;
  description?: string;
  teamGroups?: string[];
  assigneeId?: string;
  assigneeName?: string;
};

export type AssigneeCandidate = {
  id: string;
  displayName: string;
};

export interface TicketingApi {
  createTicket(input: CreateTicketInput, requester: PortalUser): Promise<TicketDetail>;
  listTickets(user: PortalUser, filters: TicketFilters): Promise<TicketSummary[]>;
  getTicket(ticketId: string, user: PortalUser): Promise<TicketDetail | null>;
  addComment(ticketId: string, user: PortalUser, body: string): Promise<TicketComment>;
  listAdminTickets(filters: AdminTicketFilters): Promise<TicketSummary[]>;
  getAdminTicket(ticketId: string): Promise<TicketDetail | null>;
  updateAdminTicket(ticketId: string, admin: PortalUser, update: AdminTicketUpdate): Promise<TicketDetail>;
  addAdminComment(ticketId: string, admin: PortalUser, body: string): Promise<TicketComment>;
}

// ---- Artifactory Module ----

export type ArtifactoryJobKind = "url-copy" | "folder-upload";

export type ArtifactoryJobStatus = "pending" | "in-progress" | "completed" | "failed" | "aborted";

export type PackageUploadStatus = "uploaded" | "exists" | "failed";

/** Ecosystem an artifact belongs to — decides which repo it is uploaded to. */
export type PackageType = "npm" | "maven" | "rpm" | "pypi" | "conda";

export type PackageUploadResult = {
  /** `arg` for npm, `org.apache.commons:commons-lang3` for Maven. */
  name: string;
  version: string;
  /** Repo-relative target, repo prefix included, e.g. `npm-local/arg/-/arg-4.1.5.tgz`. */
  path: string;
  type?: PackageType;
  status: PackageUploadStatus;
  /** Repo tree browser link. */
  url?: string;
  /** Native package view link — `/ui/native/<path>` instead of the tree browser. */
  nativeUrl?: string;
  error?: string;
};

export type ArtifactoryJob = {
  id: string;
  kind: ArtifactoryJobKind;
  status: ArtifactoryJobStatus;
  submittedBy: string;
  submittedByName: string;
  createdAt: string;
  updatedAt: string;
  /** Human name for the job — `arg@4.1.5`, or `node_modules (142 packages)`. */
  name?: string;
  sourceUrl?: string;
  folderName?: string;
  fileCount?: number;
  totalBytes?: number;
  errorMessage?: string;
  /** Artifactory repo tree link to the uploaded artifact (or the repo, for many). */
  resultUrl?: string;
  progress?: { done: number; total: number };
  packages?: PackageUploadResult[];
  log: string[];
};

export type UrlCopyInput = {
  sourceUrl: string;
};

export type UploadedFile = {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
};

export type FolderUploadInput = {
  folderName: string;
  fileCount: number;
  totalBytes: number;
  files?: UploadedFile[];
};

/** Which scripted run the Test button replays — one per package type, plus two failure modes. */
export type ArtifactoryScenario = PackageType | "partial-failure" | "total-failure";

export interface ArtifactoryApi {
  submitUrlCopy(input: UrlCopyInput, submitter: PortalUser): Promise<ArtifactoryJob>;
  submitFolderUpload(input: FolderUploadInput, submitter: PortalUser): Promise<ArtifactoryJob>;
  /** Dev-only scripted run — the routers only expose it when SSO is off. */
  simulate(submitter: PortalUser, scenario?: ArtifactoryScenario): Promise<ArtifactoryJob>;
  listJobs(user: PortalUser, allUsers?: boolean): Promise<ArtifactoryJob[]>;
  getJob(jobId: string): Promise<ArtifactoryJob | null>;
  /** `null` when there is no such job; already-finished jobs are left alone. */
  cancelJob(jobId: string, user: PortalUser, allUsers?: boolean): Promise<ArtifactoryJob | null>;
}

// ---- Whitening Module ----

export type WhiteningJobStatus = "pending" | "in-progress" | "completed" | "failed" | "aborted";

/** One log line, tagged with the phase that emitted it so the UI can collapse by step. */
export type JobLogEntry = {
  step: string;
  line: string;
};

export type WhiteningJob = {
  id: string;
  status: WhiteningJobStatus;
  submittedBy: string;
  submittedByName: string;
  createdAt: string;
  updatedAt: string;
  archiveName: string;
  department: string;
  team: string;
  project: string;
  version: string;
  prUrl?: string;
  errorMessage?: string;
  log: JobLogEntry[];
};

/** Which scripted run the Test button replays — a clean run, or a failure at one of the three stages. */
export type WhiteningScenario = "success" | "clone-failure" | "dependency-failure" | "image-failure";

export interface WhiteningApi {
  submitUnpack(archive: Buffer, archiveName: string, submitter: PortalUser): Promise<WhiteningJob>;
  /** Dev-only scripted run — the routers only expose it when SSO is off. */
  simulate(submitter: PortalUser, scenario?: WhiteningScenario): Promise<WhiteningJob>;
  listJobs(user: PortalUser, allUsers?: boolean): Promise<WhiteningJob[]>;
  getJob(jobId: string): Promise<WhiteningJob | null>;
  /** `null` when there is no such job; already-finished jobs are left alone. */
  cancelJob(jobId: string, user: PortalUser, allUsers?: boolean): Promise<WhiteningJob | null>;
}

// ---- Research Module ----

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ResearchJobStatus = "pending" | "in-progress" | "completed" | "failed" | "aborted";

/** One researchable repo, sourced from a research-* skill file — shown in the new-chat category picker. */
export type ResearchCategory = {
  name: string;
  description: string;
};

export type ResearchConversation = {
  id: string;
  /** First question, truncated — shown in the chat list. */
  title: string;
  /**
   * Picked once, fixed for the conversation's life. `null` means "not sure" —
   * the first question classifies it, using the same skill-derived category
   * list, before that turn proceeds.
   */
  project: string | null;
  /** Set after the first turn completes; reused via --session on every later turn. */
  opencodeSessionId?: string;
  submittedBy: string;
  submittedByName: string;
  createdAt: string;
  updatedAt: string;
};

export type ResearchJob = {
  id: string;
  conversationId: string;
  status: ResearchJobStatus;
  submittedBy: string;
  submittedByName: string;
  createdAt: string;
  updatedAt: string;
  project: string;
  question: string;
  /** opencode's own tool-use trace (glob/read/bash calls) — its "thinking", not the final answer. */
  thinking?: string;
  answer?: string;
  errorMessage?: string;
  log: JobLogEntry[];
};

export interface ResearchApi {
  /** Researchable repos, for the new-chat category picker. */
  listCategories(): ResearchCategory[];
  /** `project: null` starts an "I'm not sure" conversation — classified from the first question. */
  startConversation(project: string | null, submitter: PortalUser): Promise<ResearchConversation>;
  listConversations(user: PortalUser, allUsers?: boolean): Promise<ResearchConversation[]>;
  submitQuestion(conversationId: string, question: string, submitter: PortalUser): Promise<ResearchJob>;
  listJobs(conversationId: string, user: PortalUser, allUsers?: boolean): Promise<ResearchJob[]>;
  getJob(jobId: string): Promise<ResearchJob | null>;
  /** `null` when there is no such job; already-finished jobs are left alone. */
  cancelJob(jobId: string, user: PortalUser, allUsers?: boolean): Promise<ResearchJob | null>;
}
