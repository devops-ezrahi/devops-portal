import { readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

function requireEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

export type AiProject = { description: string; repoUrl: string };

// Registry lives as SKILL.md-shaped files, not an env var — but only this
// app's own code ever reads them (opencode's own skill-discovery is never
// invoked for the AI flow itself), so the directory is entirely our
// choice, not constrained to opencode's global skills path. AI_SKILLS_DIR
// makes it mountable wherever a given environment wants — a different
// ConfigMap path per cluster/deployment, no code change needed. Defaults to
// ~/.claude/skills so local dev keeps working with no env var set. Only
// `ai-*`-prefixed entries count, everywhere, so a shared directory
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

const aiProjects = scanAiSkills();
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
    enabled: Object.keys(aiProjects).length > 0,
  },
};
