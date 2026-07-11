#!/bin/sh
set -e

# ponytail: oauth2-proxy doesn't get SIGTERM forwarded on pod shutdown (Node's
# default signal handling doesn't relay to background children) — it rides
# out on the pod's terminationGracePeriodSeconds SIGKILL sweep instead. Fine
# for a homelab; upgrade path is `tini -s` as PID 1 if graceful-shutdown
# timing ever matters.
oauth2-proxy "$@" &
exec node dist/server/index-prod.js
