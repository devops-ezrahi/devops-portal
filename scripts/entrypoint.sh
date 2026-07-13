#!/bin/sh
set -e

# ponytail: neither proxy gets SIGTERM forwarded on pod shutdown (Node's
# default signal handling doesn't relay to background children) — it rides
# out on the pod's terminationGracePeriodSeconds SIGKILL sweep instead. Fine
# for a homelab; upgrade path is `tini -s` as PID 1 if graceful-shutdown
# timing ever matters.
# oauth2-proxy wants the issuer root (it appends
# /.well-known/openid-configuration itself), but a CRD-issued Keycloak
# client secret hands back the full discovery URL instead — strip the
# suffix here rather than requiring every such chart to duplicate it.
if [ -z "$OAUTH2_PROXY_OIDC_ISSUER_URL" ] && [ -n "$WELLKNOWN_URL" ]; then
  export OAUTH2_PROXY_OIDC_ISSUER_URL="${WELLKNOWN_URL%/.well-known/openid-configuration}"
fi
oauth2-proxy "$@" &
exec node dist/server/index-prod.js
