#!/usr/bin/env bash
# The dashboard image proxies the API through nginx, and the upstream is chosen when the container
# starts (API_UPSTREAM), defaulting to the compose service name. WebSocket upgrade for /hubs stays.
# Same-origin: the template adds no CORS header.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
tpl="$ROOT/src/dashboard/nginx.conf.template"
script="$ROOT/src/dashboard/10-api-upstream.sh"
dockerf="$ROOT/src/dashboard/Dockerfile"
fail=0
cases=0

ok() { cases=$((cases + 1)); printf 'ok    %s\n' "$1"; }
bad() { cases=$((cases + 1)); printf '::error::FAIL  %s\n' "$1"; fail=1; }

[ -f "$tpl" ] && ok 'the nginx template exists' || bad 'the nginx template exists'
[ ! -f "$ROOT/src/dashboard/nginx.conf" ] && ok 'the hardcoded nginx.conf is gone' || bad 'the hardcoded nginx.conf is gone'

grep -q 'proxy_pass ${API_UPSTREAM};' "$tpl" && ok 'proxy_pass uses API_UPSTREAM' || bad 'proxy_pass uses API_UPSTREAM'
grep -q 'location /hubs/' "$tpl" && ok 'hub location remains' || bad 'hub location remains'
grep -q 'location = /hubs' "$tpl" && ok 'bare hub path is proxied' || bad 'bare hub path is proxied'
grep -q 'location = /api' "$tpl" && ok 'bare api path is proxied' || bad 'bare api path is proxied'
grep -q 'location /api/' "$tpl" && ok 'api prefix remains' || bad 'api prefix remains'
grep -q 'location = /health' "$tpl" && ok 'bare health path is proxied' || bad 'bare health path is proxied'
grep -q 'location = /metrics' "$tpl" && ok 'bare metrics path is proxied' || bad 'bare metrics path is proxied'
grep -q 'proxy_set_header Upgrade $http_upgrade;' "$tpl" && ok 'websocket upgrade header remains' || bad 'websocket upgrade header remains'
grep -q 'proxy_set_header Connection $connection_upgrade;' "$tpl" && ok 'websocket connection header remains' || bad 'websocket connection header remains'
if grep -q 'futuresliquiditydashboard.api' "$tpl"; then bad 'the template does not hardcode the compose host'; else ok 'the template does not hardcode the compose host'; fi
if grep -q 'Access-Control-Allow-Origin' "$tpl"; then bad 'the template adds no CORS header'; else ok 'the template adds no CORS header'; fi
grep -q 'API_UPSTREAM=http://futuresliquiditydashboard.api:8080' "$dockerf" && ok 'the image defaults API_UPSTREAM to the compose service' || bad 'the image defaults API_UPSTREAM to the compose service'
grep -q 'nginx.conf.template' "$dockerf" && ok 'the image copies the template' || bad 'the image copies the template'
grep -q '10-api-upstream.sh' "$dockerf" && ok 'the image installs the envsubst script' || bad 'the image installs the envsubst script'
if grep -q 'COPY .* /etc/nginx/templates' "$dockerf"; then bad 'the template is not copied where the stock entrypoint rewrites every variable'; else ok 'the template is not copied where the stock entrypoint rewrites every variable'; fi
grep -q "envsubst '\${API_UPSTREAM}'" "$script" && ok 'envsubst lists only API_UPSTREAM' || bad 'envsubst lists only API_UPSTREAM'
format="$(grep '^log_format ' "$tpl")"
case "$format" in
  *'$uri'*) ok 'the access log format records $uri' ;;
  *) bad 'the access log format records $uri' ;;
esac
case "$format" in
  *'$request_method $uri'*) ok 'the access log format does not record $request' ;;
  *) bad 'the access log format does not record $request' ;;
esac
grep -q 'access_log /dev/stdout redacted_request;' "$tpl" && ok 'the server uses the redacted log' || bad 'the server uses the redacted log'

if [ "$fail" -ne 0 ]; then
  printf '\nFAIL: the dashboard nginx upstream is not configurable, or CORS was added.\n' >&2
  exit 1
fi
printf '\nOK: the dashboard proxies a configurable upstream and keeps the WebSocket upgrade (%s cases).\n' "$cases"
