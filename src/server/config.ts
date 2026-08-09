import { readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

function requireEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

export type ResearchProject = { description: string; repoUrl: string };

// Registry lives as SKILL.md files, not an env var: opencode natively reads
// skills from ~/.claude/skills/<name>/SKILL.md, so mounting one skill per
// researchable repo there (dev: real home dir; prod: a ConfigMap volume,
// see homelab) makes the same files double as this app's project registry.
// Only `research-*`-prefixed skills count, so unrelated global skills
// (usage-bar, whitening-packer, ...) aren't picked up as "repos".
function scanResearchSkills(): Record<string, ResearchProject> {
  const skillsDir = join(homedir(), ".claude", "skills");
  const projects: Record<string, ResearchProject> = {};
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return projects;
  }

  for (const entry of entries) {
    if (!entry.startsWith("research-")) continue;
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

    const name = entry.slice("research-".length);
    projects[name] = { description, repoUrl };
  }
  return projects;
}

const artifactoryUrl = requireEnv("ARTIFACTORY_URL");
const artifactoryRepo = requireEnv("ARTIFACTORY_REPO");
const artifactoryToken = requireEnv("ARTIFACTORY_TOKEN");
const artifactoryDockerRepo = requireEnv("ARTIFACTORY_DOCKER_REPO");
const artifactoryMavenRepo = requireEnv("ARTIFACTORY_MAVEN_REPO");
const artifactoryRpmRepo = requireEnv("ARTIFACTORY_RPM_REPO");
const artifactoryPypiRepo = requireEnv("ARTIFACTORY_PYPI_REPO");
const artifactoryCondaRepo = requireEnv("ARTIFACTORY_CONDA_REPO");

const gitUrl = requireEnv("GIT_URL");
const gitToken = requireEnv("GIT_TOKEN");

const researchProjects = scanResearchSkills();
const opencodeApiKey = requireEnv("OPENCODE_API_KEY");

const jiraUrl = requireEnv("JIRA_URL");
const jiraToken = requireEnv("JIRA_TOKEN");
const jiraProjectKey = requireEnv("JIRA_PROJECT_KEY");
const jiraBoardId = requireEnv("JIRA_BOARD_ID");
const jiraMaintenanceIssueType = requireEnv("JIRA_MAINTENANCE_ISSUE_TYPE");
const jiraStoryPointsField = requireEnv("JIRA_STORY_POINTS_FIELD");

export const config = {
  ssoRequired: process.env.SSO_REQUIRED === "true",
  ssoUrl: requireEnv("SSO_URL") ?? "",
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
    mavenRepo: artifactoryMavenRepo ?? "",
    rpmRepo: artifactoryRpmRepo ?? "",
    pypiRepo: artifactoryPypiRepo ?? "",
    condaRepo: artifactoryCondaRepo ?? "",
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
    enabled: !!(jiraUrl && jiraToken && jiraProjectKey),
  },
  research: {
    // name -> { description, repoUrl }, sourced from ~/.claude/skills/research-*/SKILL.md
    projects: researchProjects,
    // Empty is valid: opencode's own free-tier "opencode/*-free" models need
    // no key at all — a non-empty placeholder gets treated as a real key and
    // rejected. Only providers that actually require credentials (Anthropic,
    // OpenAI, ...) need this set.
    apiKey: opencodeApiKey ?? "",
    model: requireEnv("OPENCODE_MODEL") ?? "anthropic/claude-sonnet-5",
    enabled: Object.keys(researchProjects).length > 0,
  },
};
