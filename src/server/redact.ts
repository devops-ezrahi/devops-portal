import { config } from "./config";

// Job logs echo the commands they run, and those commands carry credentials:
// `git clone https://user:TOKEN@host/...` and `skopeo --dest-creds TOKEN:TOKEN`.
// Every log line funnels through the modules' appendLog, so scrub there.
export function redactSecrets(line: string): string {
  let out = line.replace(/(:\/\/[^/\s:@]+:)[^@\s]+@/g, "$1***@");
  for (const secret of [config.git.token, config.artifactory.token, config.ai.apiKey]) {
    if (secret) out = out.split(secret).join("***");
  }
  return out;
}
