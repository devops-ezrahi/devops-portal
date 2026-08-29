import type { PickableImage } from "./images";

/**
 * Stand-in for the Artifactory image search. `npm run dev` has no Artifactory
 * behind it, so the builder's `image` field would suggest nothing and the
 * picker could not be seen at all offline — this is what it offers instead.
 *
 * The names are the ones the library's own steps default to, and the labels are
 * shaped like the real ones: `SCREAMING_CASE` only, since that is the half
 * `listImages` keeps. `rpmbuild` has none on purpose — an image with no labels
 * has to render as a bare name rather than an empty separator.
 *
 * Dev only: `pickableImages` reaches for this only when SSO is not required and
 * no real path is configured, so a deployment never serves it.
 */
export const DEV_IMAGES: readonly PickableImage[] = [
  { name: "mvn353-jdk17", info: "JDK=17 · MAVEN=3.5.3" },
  { name: "opencode", info: "NODE=20" },
  { name: "python311", info: "OS=ubi8 · PY=3.11" },
  { name: "rpmbuild", info: "" },
  { name: "semantic-release", info: "NODE=20" },
  { name: "sonar", info: "JDK=17 · SONAR=10.4" },
  { name: "ubi8", info: "OS=ubi8" },
];
