import { config } from "../../config";
import { listImages } from "../artifactory/artifactoryRest";
import { DEV_IMAGES } from "./devSimulation";

/** One entry in the builder's image picker. */
export type PickableImage = { name: string; info: string };

// ponytail: process-local 1h cache, no invalidation — a newly pushed image
// shows up within the hour; add a refresh endpoint if that ever matters.
const TTL_MS = 60 * 60 * 1000;
let cached: { at: number; images: PickableImage[] } | null = null;

/**
 * The agent images a stage's `image` argument can take, newest listing cached
 * for an hour — the set only changes when someone pushes a new image, so this
 * is one Artifactory call per pod per hour rather than one per page load.
 *
 * Always resolves: an unconfigured path, a disabled Artifactory or a failed
 * call all give `[]`, and an empty list is what turns the picker back into the
 * plain text field it was before. A failure is deliberately **not** cached —
 * otherwise one bad response pins the field empty for an hour.
 */
export async function pickableImages(): Promise<PickableImage[]> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.images;
  if (!config.jenkinsfile.imagesPath || !config.artifactory.enabled) {
    // Nothing real to ask. Offline that means the picker could never be seen,
    // so dev gets the scripted list — never a deployment, which is what the
    // SSO check draws the line on, exactly as the Test buttons do.
    return config.ssoRequired ? [] : [...DEV_IMAGES];
  }

  const found = await listImages(config.jenkinsfile.imagesPath);
  if (!found) return [];

  const images = found.map(({ name, labels }) => ({
    name,
    info: Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join(" · "),
  }));
  cached = { at: Date.now(), images };
  return images;
}

/** Tests only — the cache is process-global and would leak between them. */
export function resetImageCache(): void {
  cached = null;
}
