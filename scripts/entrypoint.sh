#!/bin/sh
set -e

# ponytail: neither proxy gets SIGTERM forwarded on pod shutdown (Node's
# default signal handling doesn't relay to background children) — it rides
# out on the pod's terminationGracePeriodSeconds SIGKILL sweep instead. Fine
# for a homelab; upgrade path is `tini -s` as PID 1 if graceful-shutdown
# timing ever matters.
if [ "$AUTH_PROVIDER" = "openshift" ]; then
  # os4-oauth-proxy doesn't bind -upstream to an env var (unlike every other
  # scalar flag, see os4-chart's configmap.yaml) — hardcoded here since it's
  # always localhost:8080, never a per-deployment value.
  os4-oauth-proxy -upstream=http://localhost:8080 "$@" &
else
  oauth2-proxy "$@" &
fi
exec node dist/server/index-prod.js
