function requireEnv(name: string): string | undefined {
  return process.env[name] || undefined;
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

const chatApiUrl = requireEnv("CHAT_API_URL");
const chatApiKey = requireEnv("CHAT_API_KEY");

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
  chat: {
    apiUrl: chatApiUrl ?? "",
    apiKey: chatApiKey ?? "",
    model: requireEnv("CHAT_MODEL") ?? "gpt-4o-mini",
    enabled: !!(chatApiUrl && chatApiKey),
  },
};
