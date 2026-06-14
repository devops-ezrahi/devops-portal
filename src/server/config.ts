function requireEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

const artifactoryUrl = requireEnv("ARTIFACTORY_URL");
const artifactoryRepo = requireEnv("ARTIFACTORY_REPO");
const artifactoryToken = requireEnv("ARTIFACTORY_TOKEN");

const chatApiUrl = requireEnv("CHAT_API_URL");
const chatApiKey = requireEnv("CHAT_API_KEY");

const jiraUrl = requireEnv("JIRA_URL");
const jiraToken = requireEnv("JIRA_TOKEN");
const jiraProjectKey = requireEnv("JIRA_PROJECT_KEY");

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
    enabled: !!(artifactoryUrl && artifactoryRepo && artifactoryToken),
  },
  jira: {
    baseUrl: jiraUrl ?? "",
    token: jiraToken ?? "",
    projectKey: jiraProjectKey ?? "",
    enabled: !!(jiraUrl && jiraToken && jiraProjectKey),
  },
  chat: {
    apiUrl: chatApiUrl ?? "",
    apiKey: chatApiKey ?? "",
    model: requireEnv("CHAT_MODEL") ?? "gpt-4o-mini",
    enabled: !!(chatApiUrl && chatApiKey),
  },
};
