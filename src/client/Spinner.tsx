import { LoaderCircle } from "lucide-react";

/**
 * The portal's one "this is happening" mark — on a button while its request is
 * out, beside a field while it saves. Takes an icon's place rather than sitting
 * next to it, so a busy button keeps its width.
 */
export function Spinner({ size = 14 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" aria-hidden="true" />;
}
