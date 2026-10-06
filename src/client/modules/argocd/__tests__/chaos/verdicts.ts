import type { BaseLayout } from "./argo";
import type { Case } from "./cases";

/**
 * What each chaos case does to the portal today. `chaos.test.ts` runs these;
 * a case with no entry is `clean`.
 *
 * Every one of the 100 is clean. The table stays as the place to record a
 * known bug — `it.fails` keeps such a case running, and turns red the day it
 * is fixed — the way the first run's ten were recorded until they were fixed:
 * a leading `---`, files Helm cannot read, YAML 1.1 typing, the writer's
 * quoting, dropped `null` / `[]`, the base/<group>/ path, renamed files and
 * dormant folders (see git history of this file).
 */

export type Verdict = { kind: "clean" } | { kind: "bug"; why: string } | { kind: "accepted"; why: string };

/** A verdict that depends on which chart revision the repo deploys with. */
type ByLayout = Record<BaseLayout, Verdict>;

export const VERDICTS: Record<string, Verdict | ByLayout> = {};

export function verdict(c: Case, layout: BaseLayout): Verdict {
  const v = VERDICTS[c.id];
  if (v) return "kind" in v ? v : v[layout];
  return { kind: "clean" };
}
