export type CustomerStage =
  | "Submitted"
  | "Triaged"
  | "In Progress"
  | "Waiting on Customer"
  | "Resolved"
  | "Closed";

export type TicketScope = "mine" | "team";

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
  fields: Record<string, string>;
  idempotencyKey?: string;
};

export type AdminTicketUpdate = {
  stage?: CustomerStage;
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
  url?: string;
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
  /** Artifactory web UI link to the uploaded artifact (or the repo, for many). */
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

// ---- RAGFlow / Chat Module ----

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ChatSession = {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
};
