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

// ---- Argo CD Module ----

export type ArgoCdApplicationSummary = {
  name: string;
  namespace: string;
  project: string;
  environment: "dev" | "tst" | "preprod" | "prd" | "unknown";
  team: string;
  owner: string;
  criticality: "regular" | "critical";
  repoUrl: string;
  repoName: string;
  repoPathUrl: string;
  commitUrl: string;
  targetRevision: string;
  path: string;
  lastCommitHash: string;
  lastCommitMessage: string;
  lastCommitAuthor: string;
  lastCommitAt?: string;
  destinationServer: string;
  destinationNamespace: string;
  syncStatus: string;
  healthStatus: string;
  healthReason: string;
  outOfSyncReason: string;
  automated: boolean;
  manualSyncRequired: boolean;
  prune: boolean;
  selfHeal: boolean;
  allowEmpty: boolean;
  lastSyncedAt?: string;
  lastSyncResult: string;
  lastSyncTriggeredBy: string;
  lastSyncRevision: string;
  lastSyncDurationSeconds?: number;
  syncMode: "auto" | "manual";
  chartName: string;
  chartVersion: string;
  baselineVersion: string;
  baselineName: string;
  baselineStatus: "ok" | "drift" | "override" | "unknown";
  chartOverride: boolean;
  overrideReason: string;
  overrideExpiresAt?: string;
  overrideApprovalOwner: string;
  desiredImage: string;
  liveImage: string;
  imageDigest: string;
  imageDrift: boolean;
  openPrCount: number;
  approvalStatus: "none" | "open" | "waiting-approval" | "approved-not-merged" | "merged-not-synced" | "synced";
  lastApprovedPr: string;
  prAuthor: string;
  requiredReviewers: string[];
  missingReviewers: string[];
  riskScore: number;
  riskWarnings: string[];
  links: {
    argoCd: string;
    git: string;
    commit: string;
  };
};

export type ArgoCdDashboardTotals = {
  applications: number;
  outOfSync: number;
  degraded: number;
  criticalApps: number;
  prodApps: number;
  autoSyncEnabled: number;
  waitingForSync: number;
  failedSync: number;
  openPrs: number;
  notOnBaseline: number;
  chartDrift: number;
  productionRisks: number;
};

export type ArgoCdPromotionGroup = {
  name: string;
  environments: Array<{
    environment: ArgoCdApplicationSummary["environment"];
    image: string;
    chartVersion: string;
    syncStatus: string;
    healthStatus: string;
    approvalStatus: ArgoCdApplicationSummary["approvalStatus"];
  }>;
  prodBehind: boolean;
};

export type ArgoCdProjectSummary = {
  name: string;
  description: string;
  sourceRepos: string[];
  destinations: Array<{ server: string; namespace: string }>;
  orphanedResourcesEnabled: boolean;
  applicationCount: number;
  syncedCount: number;
  outOfSyncCount: number;
  healthyCount: number;
  degradedCount: number;
  applications: ArgoCdApplicationSummary[];
};

export type ArgoCdInstanceSummary = {
  id: string;
  name: string;
  url: string;
  authMode: "token" | "basic" | "sso";
};

export type ArgoCdDashboard = {
  instance: ArgoCdInstanceSummary;
  projects: ArgoCdProjectSummary[];
  applications: ArgoCdApplicationSummary[];
  totals: ArgoCdDashboardTotals;
  promotion: ArgoCdPromotionGroup[];
};

// ---- Branch Diff Module ----

export type BranchDiffRisk = "low" | "medium" | "high";

export type BranchMicroserviceSnapshot = {
  exists: boolean;
  templatePath?: string;
  valuesPath?: string;
  templateHash?: string;
  valuesHash?: string;
  templateParameters?: Record<string, string>;
  valuesParameters?: Record<string, string>;
  imageRepository?: string;
  imageTag?: string;
  replicaCount?: number;
  routeHost?: string;
  resources?: string[];
  kinds?: string[];
  hasNetworkPolicy?: boolean;
  hasSecurityContext?: boolean;
  serviceAccountName?: string;
  hpa?: {
    minReplicas?: number;
    maxReplicas?: number;
  };
};

export type BranchDiffMicroservice = {
  name: string;
  branches: Record<string, BranchMicroserviceSnapshot>;
  summary: string[];
  importantFields: Array<{
    field: string;
    values: Record<string, string>;
    risk: BranchDiffRisk;
  }>;
  valuesDiffs: string[];
  templateDiffs: string[];
  resourceDiffs: string[];
  riskLevel: BranchDiffRisk;
  templateDrift: boolean;
  valuesDrift: boolean;
  missingBranches: string[];
  productionDifference: boolean;
  secureDifference: boolean;
  badges: string[];
};

export type BranchDiffDashboard = {
  app: string;
  branches: string[];
  baselineBranch: string;
  lastScannedAt: string;
  summary: {
    totalBranches: number;
    totalMicroservices: number;
    sameAcrossAllBranches: number;
    valuesDrift: number;
    templateDrift: number;
    missingMicroservices: number;
    highRiskDifferences: number;
    productionDifferences: number;
    secureNetworkDifferences: number;
  };
  microservices: BranchDiffMicroservice[];
};

// ---- Artifactory Module ----

export type ArtifactoryJobKind = "url-copy" | "folder-upload";

export type ArtifactoryJobStatus = "pending" | "in-progress" | "completed" | "failed";

export type ArtifactoryJob = {
  id: string;
  kind: ArtifactoryJobKind;
  status: ArtifactoryJobStatus;
  submittedBy: string;
  submittedByName: string;
  createdAt: string;
  updatedAt: string;
  sourceUrl?: string;
  folderName?: string;
  fileCount?: number;
  totalBytes?: number;
  errorMessage?: string;
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

export interface ArtifactoryApi {
  submitUrlCopy(input: UrlCopyInput, submitter: PortalUser): Promise<ArtifactoryJob>;
  submitFolderUpload(input: FolderUploadInput, submitter: PortalUser): Promise<ArtifactoryJob>;
  listJobs(user: PortalUser, allUsers?: boolean): Promise<ArtifactoryJob[]>;
  getJob(jobId: string): Promise<ArtifactoryJob | null>;
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
