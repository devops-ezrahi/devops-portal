import { config } from "../../config";
import { safeFilePath, tokenFor } from "../../repoGuards";

/**
 * The guards standing between the builder and a git repo it can write to.
 *
 * Both exist because the destination is *user-editable*: `values.repoUrl` is a
 * free-text field in the Repositories panel, and the pushed file list is
 * generated in the browser. Neither can be trusted the way a config value can.
 *
 * `safeRepoUrl`, `safeRef` and `safeDirPath` moved to `src/server/repoGuards.ts`
 * when the Jenkinsfile builder grew the same two buttons — the rules about what
 * git may be pointed at are not this module's. They are re-exported here so
 * every caller and test keeps the import it had.
 */

export { safeDirPath, safeRef, safeRepoUrl } from "../../repoGuards";

/**
 * Credential for *this* host, or nothing. `tokenFor`'s fallback is this
 * module's own variable: a values repo is usually not on the GIT_URL host, so
 * it needs one, and the host match is what stops it reaching anywhere else.
 */
export function valuesTokenFor(repoUrl: string): { token: string; username: string } {
  return tokenFor(repoUrl, config.argocd.valuesToken);
}

/**
 * A path this module will write inside a clone: `safeFilePath`, plus the
 * `.yaml` suffix, which is a rule about *this* tree rather than about git —
 * every file `buildTree` generates is YAML, so anything else is a mistake
 * worth refusing before it reaches a worktree.
 */
export function safeTreePath(path: string): boolean {
  return path.endsWith(".yaml") && safeFilePath(path);
}
