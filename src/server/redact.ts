import { config } from "./config";

// Job logs echo the commands they run, and those commands carry credentials:
// `git clone https://user:TOKEN@host/...` and `skopeo --dest-creds TOKEN:TOKEN`.
// Every log line funnels through the modules' appendLog, so scrub there.
export function redactSecrets(line: string): string {
  let out = line.replace(/(:\/\/[^/\s:@]+:)[^@\s]+@/g, "$1***@");
  // Optional-chained on purpose: this runs inside `log.emit`, so a config
  // section that is not there must not throw — a logger that dies takes the job
  // it was logging with it, and the missing half is the one with no secret in
  // it anyway. (Every test that stubs `./config` stubs it partially, which is
  // how this was found.)
  for (const secret of [
    config.git?.token,
    config.artifactory?.token,
    config.artifactory?.npmSourceToken,
    config.ai?.apiKey,
    config.argocd?.valuesToken,
  ]) {
    if (secret) out = out.split(secret).join("***");
  }
  return out;
}
