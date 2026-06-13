function requireEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

const artifactoryUrl = requireEnv("ARTIFACTORY_URL");
const artifactoryRepo = requireEnv("ARTIFACTORY_REPO");
const artifactoryToken = requireEnv("ARTIFACTORY_TOKEN");

const chatApiUrl = requireEnv("CHAT_API_URL");
const chatApiKey = requireEnv("CHAT_API_KEY");

export const config = {
  chatMock: process.env.CHAT_MOCK === "true",
  ssoRequired: process.env.SSO_REQUIRED === "true",
  ssoUrl: requireEnv("SSO_URL") ?? "",
  adminGroup: requireEnv("ADMIN_GROUP") ?? "portal-admins",
  artifactory: {
    url: artifactoryUrl ?? "",
    repo: artifactoryRepo ?? "",
    token: artifactoryToken ?? "",
    enabled: !!(artifactoryUrl && artifactoryRepo && artifactoryToken),
  },
  chat: {
    apiUrl: chatApiUrl ?? "",
    apiKey: chatApiKey ?? "",
    model: requireEnv("CHAT_MODEL") ?? "gpt-4o-mini",
    enabled: !!(chatApiUrl && chatApiKey),
  },
};
