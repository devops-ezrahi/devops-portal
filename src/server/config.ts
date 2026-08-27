import { readFileSync, readdirSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

function requireEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

export type AiProject = { description: string; repoUrl: string };

// Registry lives as real SKILL.md files, not an env var — and opencode's own
// skill-discovery reads the same files: RealAiApi.ts tells it "use the
// ai-<project> skill", opencode loads the SKILL.md body (the actual "how to
// work with this repo" instructions) via its native `skill` tool. This code
// only extracts `description` + `Repo:` for the picker UI and the clone step
// (opencode has no bash access, so it can never clone itself).
//
// That native discovery is fixed to a few paths opencode always scans:
// ~/.claude/skills, ~/.config/opencode/skills, ~/.agents/skills (global) plus
// .opencode/skills, .claude/skills, .agents/skills walking up from cwd
// (project). AI_SKILLS_DIR defaults to ~/.claude/skills — one of those paths
// — so local dev and the default prod mount both get native invocation for
// free. If a deployment ever points AI_SKILLS_DIR somewhere else, keep it one
// of opencode's own scan paths or the `skill` tool simply won't find it.
// Only `ai-*`-prefixed entries count, everywhere, so a shared directory
// doesn't pick up unrelated skills (usage-bar, whitening-packer, ...) as repos.
const aiSkillsDir = requireEnv("AI_SKILLS_DIR") ?? join(homedir(), ".claude", "skills");

function scanAiSkills(): Record<string, AiProject> {
  const skillsDir = aiSkillsDir;
  const projects: Record<string, AiProject> = {};
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return projects;
  }

  for (const entry of entries) {
    if (!entry.startsWith("ai-")) continue;
    const skillPath = join(skillsDir, entry, "SKILL.md");
    let text: string;
    try {
      text = readFileSync(skillPath, "utf8");
    } catch {
      continue;
    }

    const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
    const repoUrl = text.match(/^Repo:\s*(\S+)/m)?.[1]?.trim() ?? "";
    if (!repoUrl) continue;

    const name = entry.slice("ai-".length);
    projects[name] = { description, repoUrl };
  }
  return projects;
}

// Where job history, the AI repo clones and opencode's session store live. In k8s
// this is the PVC mount; the tmpdir default is purely so local dev works with an
// empty .env. Everything under it is derived, so there is no second path var.
const dataDir = requireEnv("DATA_DIR") ?? join(tmpdir(), "portal-data");

const artifactoryUrl = requireEnv("ARTIFACTORY_URL");
const artifactoryRepo = requireEnv("ARTIFACTORY_REPO");
const artifactoryToken = requireEnv("ARTIFACTORY_TOKEN");
const artifactoryDockerRepo = requireEnv("ARTIFACTORY_DOCKER_REPO");
const artifactoryNpmRepo = requireEnv("ARTIFACTORY_NPM_REPO");
const artifactoryMavenRepo = requireEnv("ARTIFACTORY_MAVEN_REPO");
const artifactoryRpmRepo = requireEnv("ARTIFACTORY_RPM_REPO");
const artifactoryPypiRepo = requireEnv("ARTIFACTORY_PYPI_REPO");
const artifactoryCondaRepo = requireEnv("ARTIFACTORY_CONDA_REPO");
const npmSourceToken = requireEnv("NPM_SOURCE_TOKEN");

const gitUrl = requireEnv("GIT_URL");
const gitToken = requireEnv("GIT_TOKEN");

/** Hours from env to ms, falling back on anything that isn't a number (0 is valid — it makes the sweep immediate, which is how you test it). */
function hours(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return (Number.isFinite(n) && n >= 0 ? n : fallback) * 3_600_000;
}

const aiProjects = scanAiSkills();
const opencodeApiKey = requireEnv("OPENCODE_API_KEY");

const jiraUrl = requireEnv("JIRA_URL");
const jiraToken = requireEnv("JIRA_TOKEN");
const jiraProjectKey = requireEnv("JIRA_PROJECT_KEY");
const jiraBoardId = requireEnv("JIRA_BOARD_ID");
const jiraMaintenanceIssueType = requireEnv("JIRA_MAINTENANCE_ISSUE_TYPE");
const jiraStoryPointsField = requireEnv("JIRA_STORY_POINTS_FIELD");
const jiraTicketLabel = requireEnv("JIRA_TICKET_LABEL");

export const config = {
  // debug|info|warn|error. `debug` adds the successful GET lines (job and
  // ticket lists poll every 2-8s per open tab) and the per-call detail of every
  // outbound Artifactory/Jira/Bitbucket request.
  logLevel: (requireEnv("LOG_LEVEL") ?? "info").trim().toLowerCase(),
  dataDir,
  ssoRequired: process.env.SSO_REQUIRED === "true",
  ssoUrl: requireEnv("SSO_URL") ?? "",
  // Header carrying the IdP's `name` claim. Lowercased because Node lowercases
  // incoming header names. Unset keeps the previous behaviour: fall back to
  // the preferred-username headers.
  ssoNameHeader: (requireEnv("SSO_NAME_HEADER") ?? "").trim().toLowerCase(),
  adminGroups: (requireEnv("ADMIN_GROUP") ?? "portal-admins")
    .split("|")
    .map((g) => g.trim())
    .filter(Boolean),
  allowedGroups: (requireEnv("ALLOWED_GROUPS") ?? "")
    .split("|")
    .map((g) => g.trim())
    .filter(Boolean),
  artifactory: {
    url: artifactoryUrl ?? "",
    repo: artifactoryRepo ?? "",
    token: artifactoryToken ?? "",
    dockerRepo: artifactoryDockerRepo ?? "",
    // Per-type repos: JFrog indexes each package type in its own repo, so a .jar
    // cannot land in the npm repo. Unset means that type is simply unavailable —
    // matching files are skipped with a log line, never a failed job.
    //
    // npm is the exception that used to have no var of its own: ARTIFACTORY_REPO
    // was both "the npm repo" and the generic fallback. ARTIFACTORY_NPM_REPO now
    // names it like every other type, and falls back to ARTIFACTORY_REPO so
    // existing deployments keep working untouched. `repo` stays the fallback for
    // unrecognised artifacts and the enabled gate.
    npmRepo: artifactoryNpmRepo || artifactoryRepo || "",
    mavenRepo: artifactoryMavenRepo ?? "",
    rpmRepo: artifactoryRpmRepo ?? "",
    pypiRepo: artifactoryPypiRepo ?? "",
    condaRepo: artifactoryCondaRepo ?? "",
    // Credential for the *source* npm registry, used only by a URL copy with
    // "Include dependencies" ticked and only when that registry is protected.
    // Normally empty: a public registry needs nothing, and a source registry on
    // the same host as ARTIFACTORY_URL reuses ARTIFACTORY_TOKEN automatically.
    npmSourceToken: npmSourceToken ?? "",
    enabled: !!(artifactoryUrl && artifactoryRepo && artifactoryToken),
  },
  git: {
    url: gitUrl ?? "",
    token: gitToken ?? "",
    // Empty by default: Bitbucket takes the HTTP access token on its own. Set
    // GIT_USERNAME only if your instance wants username+token basic auth.
    username: requireEnv("GIT_USERNAME") ?? "",
    enabled: !!(gitUrl && gitToken),
  },
  jenkinsfile: {
    // The one library every generated Jenkinsfile imports. The builder only
    // asks for a branch to pin — the name is a deployment fact, not a per-user
    // choice, so it is set here rather than typed into every pipeline.
    sharedLibrary: (requireEnv("JENKINS_SHARED_LIBRARY") ?? "jenkins-k8s-shared-library").trim(),
  },
  jira: {
    baseUrl: jiraUrl ?? "",
    token: jiraToken ?? "",
    projectKey: jiraProjectKey ?? "",
    boardId: jiraBoardId ?? "",
    maintenanceIssueType: jiraMaintenanceIssueType ?? "Maintenance",
    // Story points is a Jira custom field with an instance-specific id
    // (customfield_10016 on many instances) — unset means the Jira backend
    // skips reading/writing it, and only the portal's own copy is kept.
    storyPointsField: jiraStoryPointsField ?? "",
    // Only issues carrying this label are listed, and every ticket the portal
    // creates gets it. Unset = the whole project is in scope, which is the
    // behaviour before this var existed.
    ticketLabel: jiraTicketLabel ?? "",
    enabled: !!(jiraUrl && jiraToken && jiraProjectKey),
  },
  ai: {
    // name -> { description, repoUrl }, sourced from ~/.claude/skills/ai-*/SKILL.md
    projects: aiProjects,
    // Reported at startup: an empty registry is otherwise indistinguishable
    // from a wrong or unmounted path.
    skillsDir: aiSkillsDir,
    // Empty is valid: opencode's own free-tier "opencode/*-free" models need
    // no key at all — a non-empty placeholder gets treated as a real key and
    // rejected. Only providers that actually require credentials (Anthropic,
    // OpenAI, ...) need this set.
    apiKey: opencodeApiKey ?? "",
    model: requireEnv("OPENCODE_MODEL") ?? "anthropic/claude-sonnet-5",
    // Points the provider at a gateway/proxy instead of its public endpoint.
    // opencode has no env var for this — it is provider.<id>.options.baseURL in
    // its config file, which we already generate (see RealAiApi's policy).
    baseUrl: requireEnv("OPENCODE_BASE_URL") ?? "",
    // Idle past this and a chat folds into the client's "Archived" section.
    // Archiving is all there is now: jobs live on the PVC, so nothing has to be
    // dropped to reclaim the tool traces and logs a chat carries.
    archiveAfterMs: hours(requireEnv("AI_ARCHIVE_AFTER_HOURS"), 4),
    enabled: Object.keys(aiProjects).length > 0,
  },
};
