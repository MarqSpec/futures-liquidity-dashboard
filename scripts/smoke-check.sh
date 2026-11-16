#!/usr/bin/env bash
# The check that decides whether a deployment stays or is rolled back: the environment's URL must answer
# 2xx on HEALTH_PATH within about a minute. The URL comes from the GitHub Environment variable
# STAGING_URL or PRODUCTION_URL. With none set it checks nothing and passes, so a fresh repository's release runs stay green, but it
# warns (and says so in the job summary when GITHUB_STEP_SUMMARY is set) that the release is unverified.
# HEALTH_PATH defaults to /health/live, which stays anonymous. A deeper check of /health/ready, outside
# Development, sends the environment secret SMOKE_API_KEY as the X-Api-Key header. Never put that key in the URL.
#
# Usage: scripts/smoke-check.sh <staging|production>
set -euo pipefail
env="${1:?environment}"
var="$(tr '[:lower:]' '[:upper:]' <<<"$env")_URL"
url="${!var:-}"
provider="$(printf '%s' "${DEPLOY_PROVIDER:-placeholder}" | tr '[:upper:]' '[:lower:]')"
if [[ -z "$url" ]]; then
  if [[ "$provider" != "placeholder" ]]; then
    msg="${env} is unverified and the release fails: DEPLOY_PROVIDER is ${provider} but ${var} is not set, so no smoke check ran and nothing would roll the deploy back. Set the environment variable ${var} on the deploy environment (DEPLOYMENT.md, section 4)."
    echo "::error::${msg}"
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '> [!CAUTION]\n> %s\n\n' "$msg" >> "$GITHUB_STEP_SUMMARY"; fi
    exit 1
  fi
  msg="${env} is unverified: ${var} is not set, so no smoke check ran and nothing confirms the release is up or would roll it back. Set the environment variable ${var} on the deploy environment (DEPLOYMENT.md, section 4)."
  echo "::warning::${msg}"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '> [!WARNING]\n> %s\n\n' "$msg" >> "$GITHUB_STEP_SUMMARY"; fi
  exit 0
fi
target="${url%/}${HEALTH_PATH:-/health/live}"
if [ "${HEALTH_PATH:-/health/live}" = "/health/ready" ] && [ -z "${SMOKE_API_KEY:-}" ]; then
  echo "::error::HEALTH_PATH is /health/ready but SMOKE_API_KEY is not set. Put that secret on the deploy environment and send it as the X-Api-Key header. Never put the key in the URL."
  exit 1
fi
header_args=()
header_file=""
cleanup() { [ -z "$header_file" ] || rm -f "$header_file"; }
trap cleanup EXIT
if [ -n "${SMOKE_API_KEY:-}" ]; then
  header_file="$(mktemp)"
  chmod 600 "$header_file"
  printf 'X-Api-Key: %s\n' "$SMOKE_API_KEY" > "$header_file"
  header_args=(-H "@${header_file}")
fi
for attempt in $(seq 1 10); do
  if curl --fail --silent --show-error --max-time 10 --output /dev/null "${header_args[@]}" "$target"; then
    echo "Smoke check passed: ${target}"
    exit 0
  fi
  echo "attempt ${attempt}/10: ${target} not healthy yet"
  sleep 6
done
echo "::error::Smoke check failed: ${target} did not answer 2xx."
exit 1
