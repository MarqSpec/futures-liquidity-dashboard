#!/usr/bin/env bash
# shellcheck disable=SC2154  # rc, out, calls, summary, argv and headers are set by deploy()
# Proves scripts/deploy.sh, the hosting hook promote.sh calls (DEPLOYMENT.md §10). Unset, the provider
# is the placeholder: it deploys nothing, warns so, and exits 0. With DEPLOY_PROVIDER=railway it deploys every image
# in IMAGES to the one Railway service whose source is <image>:<environment>, in the environment its project token
# is scoped to, waits for each deployment to succeed, and checks that it runs the digest the registry holds for the
# tag. Before deploying anything it refuses a token for another environment, a service there that builds from a
# repository or runs no image, an image no service runs (or more than one does), and a tag with no digest. It fails
# when a deployment ends in any state but SUCCESS, never succeeds within the polls, or runs another digest, and
# deploys nothing after it. The token goes in a header, never on a command line or in the output.
# Stub `curl` (Railway's GraphQL API), `docker` (the registry) and `sleep` are exported functions that log every call,
# so the order of calls is asserted exactly. jq is the real one. No network, no registry.
#
#   STUB_SERVICES     one "name|image|repo" line per service in the token's environment (an empty field: null)
#   STUB_TOKEN_ENV    the Railway environment the token is scoped to (default: the one deployed); its id is env-<name>
#   STUB_STATUSES     the statuses each deployment reports, one per poll (default: "SUCCESS"; the last one repeats)
#   STUB_RUN_DIGEST   the digest Railway reports running (default: the registry's) · STUB_NO_RUN_DIGEST  it reports none
#   STUB_STATUSES_<service> / STUB_RUN_DIGEST_<service>  the same for that service alone (STUB_STATUSES_web, …)
#   STUB_POLL_ERRORS  how many polls of each deployment answer with GraphQL errors before it answers properly
#   STUB_POLL_ERROR_AT  which polls of each deployment (counting every one asked, 1 first) answer with errors instead
#   STUB_INDEX        the registry holds each tag as an index: a linux/amd64 image, a linux/arm64 one, an attestation
#   STUB_RUN_INDEX    Railway reports running the index's own digest
#   STUB_NO_DIGEST    the registry has no digest for the tag · STUB_REGISTRY_FAILS  it cannot find the tag at all
#   STUB_NO_DEPLOYMENT  Railway starts no deployment
#   STUB_GQL_ERRORS / STUB_CURL_FAILS / STUB_NOT_JSON / STUB_NULL  the operation that answers with GraphQL errors,
#                     fails, answers with something that is not JSON, or answers null
set -uo pipefail

command -v jq >/dev/null || { echo "deploy.test.sh needs jq: deploy.sh reads Railway's answers with it" >&2; exit 1; }

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$DIR/../deploy.sh"
W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT

# A subject that does not parse fails every refusal case for the wrong reason: check it is a program first.
if ! bash -n "$DEPLOY"; then echo "::error::FAIL  scripts/deploy.sh does not parse" >&2; exit 1; fi

# curl ... -H @- --data-binary <json> <url>: answers the GraphQL operation the body names. A header file is read only
# from standard input (`@-`): any other `-H @<path>` fails as Git Bash's native curl.exe fails on a /proc/<pid>/fd path.
curl() {
  { local -; set +x; } 2>/dev/null   # under `bash -x`, the stub must not be what traces the token it reads
  local a body="" headers="" argv="$*"
  while [ $# -gt 0 ]; do
    a="$1"; shift
    case "$a" in
      --data-binary) body="$1"; shift ;;
      -H)
        if [ "$1" = @- ]; then
          local h=""; IFS= read -r -d '' h || true; headers+="${h%$'\n'}"$'\n'
        elif [[ $1 == @* ]]; then
          printf 'curl: Failed to open %s\ncurl: option -H: error encountered when reading a file\n' "${1#@}"; return 26
        else
          headers+="$1"$'\n'
        fi
        shift ;;
    esac
  done
  printf '%s\n' "$argv" >> "$CASE_DIR/argv"
  printf '%s' "$headers" >> "$CASE_DIR/headers"
  # The operation and its variables, read with the shell's own matching: a jq per call costs a process.
  local op="" v1="" v2=""
  case "$body" in
    *'projectToken'*) op=projectToken ;;
    *'serviceInstanceDeployV2('*) op=serviceInstanceDeployV2 ;;
    *'deployment(id'*) op=deployment ;;
  esac
  [[ $body =~ \"(s|id)\":\"([^\"]*)\" ]] && v1="${BASH_REMATCH[2]}"
  [[ $body =~ \"e\":\"([^\"]*)\" ]] && v2="${BASH_REMATCH[1]}"
  if [ "${STUB_CURL_FAILS:-}" = "$op" ]; then echo '{"message":"bad gateway"}'; return 22; fi
  if [ "${STUB_NOT_JSON:-}" = "$op" ]; then echo '<html>bad gateway</html>'; return 0; fi
  if [ "${STUB_NULL:-}" = "$op" ]; then echo 'null'; return 0; fi
  if [ "${STUB_GQL_ERRORS:-}" = "$op" ]; then echo '{"errors":[{"message":"Not Authorized"}],"data":null}'; return 0; fi
  case "$op" in
    projectToken)
      echo "railway projectToken" >> "$CASE_DIR/calls"
      printf '%s\n' "$(< "$CASE_DIR/env.json")" ;;
    serviceInstanceDeployV2)
      echo "railway deploy $v1 in $v2" >> "$CASE_DIR/calls"
      if [ -n "${STUB_NO_DEPLOYMENT:-}" ]; then echo '{"data":{"serviceInstanceDeployV2":null}}'; return 0; fi
      printf '{"data":{"serviceInstanceDeployV2":"dep-%s"}}\n' "$v1" ;;
    deployment)
      local id="$v1" n=0 e=0 asked=0 status image="" digest st line svc="${v1#dep-svc-}" statuses_var run_var
      echo "railway poll $id" >> "$CASE_DIR/calls"
      [ -f "$CASE_DIR/asked-$id" ] && read -r asked < "$CASE_DIR/asked-$id"
      asked=$((asked + 1)); echo "$asked" > "$CASE_DIR/asked-$id"
      [ -f "$CASE_DIR/errors-$id" ] && read -r e < "$CASE_DIR/errors-$id"
      if [ "$e" -lt "${STUB_POLL_ERRORS:-0}" ] || [[ " ${STUB_POLL_ERROR_AT:-} " == *" $asked "* ]]; then
        echo "$((e + 1))" > "$CASE_DIR/errors-$id"
        echo '{"errors":[{"message":"Service Unavailable"}],"data":null}'; return 0
      fi
      [ -f "$CASE_DIR/polls-$id" ] && read -r n < "$CASE_DIR/polls-$id"
      n=$((n + 1)); echo "$n" > "$CASE_DIR/polls-$id"
      statuses_var="STUB_STATUSES_$svc"; run_var="STUB_RUN_DIGEST_$svc"
      read -ra st <<<"${!statuses_var:-${STUB_STATUSES:-SUCCESS}}"
      status="${st[$((n - 1))]:-${st[${#st[@]} - 1]}}"
      while IFS= read -r line; do [ "${line%%|*}" = "${id#dep-}" ] && image="${line#*|}"; done < "$CASE_DIR/ids"
      digest="${!run_var:-${STUB_RUN_DIGEST:-$(digest_of "$image")}}"
      [ -z "${STUB_RUN_INDEX:-}" ] || digest="${digest/sha256:/sha256:index-}"
      if [ -z "${STUB_NO_RUN_DIGEST:-}" ]; then digest="\"$digest\""; else digest=null; fi
      printf '{"data":{"deployment":{"status":"%s","meta":{"image":"%s","imageDigest":%s}}}}\n' "$status" "$image" "$digest" ;;
    *) echo "unexpected operation in '$body'" >&2; return 2 ;;
  esac
}
# docker buildx imagetools inspect <ref> --format '{{json .Manifest}}'
docker() {
  [ "$1 $2 $3" = "buildx imagetools inspect" ] || { echo "docker $*" >> "$CASE_DIR/calls"; return 2; }
  echo "registry $4" >> "$CASE_DIR/calls"
  if [ -n "${STUB_REGISTRY_FAILS:-}" ]; then echo "ERROR: $4: not found" >&2; return 1; fi
  if [ -n "${STUB_NO_DIGEST:-}" ]; then echo '{}'; return 0; fi
  local d
  d="$(digest_of "$4")"
  if [ -n "${STUB_INDEX:-}" ]; then
    printf '{"mediaType":"application/vnd.oci.image.index.v1+json","digest":"%s","manifests":[' "${d/sha256:/sha256:index-}"
    printf '{"digest":"%s","platform":{"os":"linux","architecture":"amd64"}},' "$d"
    printf '{"digest":"%s","platform":{"os":"linux","architecture":"arm64"}},' "${d/sha256:/sha256:arm64-}"
    printf '{"digest":"%s","platform":{"os":"unknown","architecture":"unknown"}}]}\n' "${d/sha256:/sha256:attestation-}"
  else
    printf '{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"%s"}\n' "$d"
  fi
}
digest_of() { local r="${1##*/}"; printf 'sha256:%s' "${r//:/-}"; }   # ghcr.io/o/app:staging -> sha256:app-staging
sleep() { echo "sleep $*" >> "$CASE_DIR/calls"; }
az() { echo "az $*" >> "$CASE_DIR/calls"; }
export -f curl docker digest_of sleep az

fail=0
n=0
cases=0
slurp() { # <var> <file>: the file's text, without CRs and trailing newlines, or nothing if it is not there
  local _t=""
  if [ -r "$2" ]; then IFS= read -r -d '' _t < "$2" || true; fi
  _t=${_t//$'\r'/}
  while [[ $_t == *$'\n' ]]; do _t=${_t%$'\n'}; done
  printf -v "$1" '%s' "$_t"
}
# deploy <args...>: runs the script against STUB_SERVICES (under `bash -x` when DEPLOY_TRACE is set); sets rc, out, calls (registry reads, Railway calls and
# sleeps, in order), summary (what it wrote for the job summary), argv (curl's command lines) and headers
deploy() {
  n=$((n + 1))
  export CASE_DIR="$W/c$n" GITHUB_STEP_SUMMARY="$W/c$n/summary"
  mkdir -p "$CASE_DIR"
  local name image repo nodes=""
  while IFS='|' read -r name image repo; do
    [ -n "$name" ] || continue
    echo "svc-$name|$image" >> "$CASE_DIR/ids"
    [ -n "$image" ] && image="\"$image\"" || image=null
    [ -n "$repo" ] && repo="\"$repo\"" || repo=null
    nodes+="${nodes:+,}{\"node\":{\"serviceId\":\"svc-$name\",\"serviceName\":\"$name\",\"source\":{\"image\":$image,\"repo\":$repo}}}"
  done <<<"${STUB_SERVICES:-}"
  local scope="${STUB_TOKEN_ENV:-${1:-}}"
  printf '{"data":{"projectToken":{"projectId":"proj-1","environmentId":"env-%s","environment":{"name":"%s","serviceInstances":{"edges":[%s]}}}}}\n' \
    "$scope" "$scope" "$nodes" > "$CASE_DIR/env.json"
  bash ${DEPLOY_TRACE:+-x} "$DEPLOY" "$@" > "$CASE_DIR/out" 2>&1; rc=$?
  slurp out "$CASE_DIR/out"; slurp calls "$CASE_DIR/calls"; slurp summary "$CASE_DIR/summary"
  slurp argv "$CASE_DIR/argv"; slurp headers "$CASE_DIR/headers"
}
check() { # <what> <command...>: passes when the command succeeds
  local what="$1"; shift
  cases=$((cases + 1))
  if "$@"; then printf 'ok    %s\n' "$what"; else printf '::error::FAIL  %s\n' "$what"; dump; fail=1; fi
}
is()    { [ "$1" = "$2" ]; }
has()   { [[ $1 == *"$2"* ]]; }
lacks() { [[ $1 != *"$2"* ]]; }
dump() { printf '%s\n--- calls ---\n%s\n--- summary ---\n%s\n' "$out" "$calls" "$summary"; }
# refused <what>: a red case asserts twice - it failed, and it deployed nothing
refused() {
  check "$1: it fails (got $rc)" is "$((rc != 0))" 1
  check "$1: and deploys nothing" lacks "$calls" 'railway deploy'
}
# polls <deployment>: how many times the case polled it
polls() { local c=0 l; while IFS= read -r l; do [ "$l" = "railway poll $1" ] && c=$((c + 1)); done <<<"$calls"; echo "$c"; }

TOKEN='rw-synthetic-token-0000'
# A developer shell may have a host selected or Railway settings exported. Each case sets what it needs.
unset DEPLOY_PROVIDER RAILWAY_TOKEN RAILWAY_ENVIRONMENT_ID IMAGES GITHUB_REPOSITORY \
  GITHUB_STEP_SUMMARY DEPLOY_POLL_SECONDS DEPLOY_POLL_ATTEMPTS STUB_SERVICES STUB_TOKEN_ENV STUB_STATUSES \
  STUB_RUN_DIGEST STUB_NO_RUN_DIGEST STUB_INDEX STUB_RUN_INDEX STUB_NO_DIGEST STUB_REGISTRY_FAILS STUB_NO_DEPLOYMENT \
  STUB_GQL_ERRORS STUB_CURL_FAILS STUB_NOT_JSON STUB_NULL STUB_POLL_ERRORS STUB_POLL_ERROR_AT STUB_STATUSES_web STUB_RUN_DIGEST_web \
  DEPLOY_TRACE AZURE_CONTAINER_APP
STAGING='api|ghcr.io/o/app:staging|
web|ghcr.io/o/app-web:staging|
postgres|postgres:17|'
PRODUCTION='api|ghcr.io/o/app:production|
web|ghcr.io/o/app-web:production|
postgres|postgres:17|'

# --- Usage -----------------------------------------------------------------------------------------------------------
deploy
check "no arguments are refused (got $rc)" is "$((rc != 0))" 1
check 'the refusal names the missing environment' has "$out" 'environment'
deploy qa 1.2.3
check "an unknown environment is refused with status 2 (got $rc)" is "$rc" 2
check 'the refusal names it' has "$out" "unknown environment 'qa'"

# --- The placeholder: nothing deployed, and it says so ---------------------------------------------------------------
STUB_SERVICES=$STAGING deploy staging 1.2.3
check "with no DEPLOY_PROVIDER it passes, so a fresh repository stays green (got $rc)" is "$rc" 0
check 'it warns that nothing was deployed' \
  has "$out" '::warning::Nothing was deployed to staging: scripts/deploy.sh is still the placeholder'
check 'the warning goes to the job summary too' has "$summary" '> [!WARNING]
> Nothing was deployed to staging'
check 'and it asks nothing of Railway or the registry' is "$calls" ''

export DEPLOY_PROVIDER=railway IMAGES='ghcr.io/o/app ghcr.io/o/app-web'

# --- Railway's own inputs, checked before anything is asked of it -----------------------------------------------------
STUB_SERVICES=$STAGING deploy staging 1.2.3
check "railway with no RAILWAY_TOKEN fails instead of warning (got $rc)" is "$rc" 1
check 'it names the missing token' has "$out" '::error::DEPLOY_PROVIDER is railway but RAILWAY_TOKEN is not set.'
check 'and asks nothing of Railway or the registry' is "$calls" ''

RAILWAY_TOKEN=$TOKEN IMAGES='' STUB_SERVICES=$STAGING deploy staging 1.2.3
check "no IMAGES and no GITHUB_REPOSITORY fails (got $rc)" is "$rc" 1
check 'it says there is no image to deploy' has "$out" 'neither IMAGES nor GITHUB_REPOSITORY is set, so there is no image to deploy'

RAILWAY_TOKEN=$TOKEN DEPLOY_POLL_SECONDS=10s STUB_SERVICES=$STAGING deploy staging 1.2.3
check "a DEPLOY_POLL_SECONDS that is not a number fails (got $rc)" is "$rc" 1
check 'it names the value' has "$out" "DEPLOY_POLL_SECONDS is '10s', not a whole number of seconds"
RAILWAY_TOKEN=$TOKEN DEPLOY_POLL_ATTEMPTS=0 STUB_SERVICES=$STAGING deploy staging 1.2.3
check "a DEPLOY_POLL_ATTEMPTS of 0, which would never wait, fails (got $rc)" is "$rc" 1
check 'it names the value' has "$out" "DEPLOY_POLL_ATTEMPTS is '0', not a positive whole number"
check 'and asks nothing of Railway' is "$calls" ''

# --- A release: every image's service, in IMAGES order, waited for and checked ---------------------------------------
RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_STATUSES='INITIALIZING DEPLOYING SUCCESS' deploy staging 1.2.3
check "a release that deploys and runs the registry's digest passes (got $rc)" is "$rc" 0
check 'it resolves every service first, then deploys one at a time, waiting on each until it succeeds' is "$calls" \
'railway projectToken
registry ghcr.io/o/app:staging
registry ghcr.io/o/app-web:staging
railway deploy svc-api in env-staging
railway poll dep-svc-api
sleep 10
railway poll dep-svc-api
sleep 10
railway poll dep-svc-api
railway deploy svc-web in env-staging
railway poll dep-svc-web
sleep 10
railway poll dep-svc-web
sleep 10
railway poll dep-svc-web'
check 'it deploys only the services that run a released image, never the database' lacks "$calls" 'svc-postgres'
check 'it says what runs where, by digest' \
  has "$out" 'Deployed 1.2.3 to staging: api runs ghcr.io/o/app:staging (sha256:app-staging), deployment dep-svc-api.'
# shellcheck disable=SC2016  # the backticks are Markdown, not a command substitution
check 'the job summary names every service and digest' is "$summary" \
'- `api` runs `ghcr.io/o/app:staging` (`sha256:app-staging`), deployment `dep-svc-api`
- `web` runs `ghcr.io/o/app-web:staging` (`sha256:app-web-staging`), deployment `dep-svc-web`'
check 'it authenticates with the project token header, read from standard input' has "$headers" "Project-Access-Token: ${TOKEN}"
check 'every request carries it' is "$(grep -c "^Project-Access-Token: ${TOKEN}$" <<<"$headers")" "$(grep -c . <<<"$argv")"
check 'the token is never on a command line' lacks "$argv" "$TOKEN"
check 'and never in the output' lacks "$out" "$TOKEN"
check "it talks to Railway's public API" has "$argv" 'https://backboard.railway.com/graphql/v2'
check 'an HTTP error status fails the request, its body kept for the message' has "$argv" '--fail-with-body'
check 'and no request waits for ever' has "$argv" '--max-time 30'

RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$PRODUCTION deploy production 2.0.0
check "production deploys the :production images with a production token (got $rc)" is "$rc" 0
check 'it reads the :production tags and deploys in the token environment' is "$calls" \
'railway projectToken
registry ghcr.io/o/app:production
registry ghcr.io/o/app-web:production
railway deploy svc-api in env-production
railway poll dep-svc-api
railway deploy svc-web in env-production
railway poll dep-svc-web'

RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING DEPLOY_POLL_SECONDS=3 STUB_STATUSES='DEPLOYING SUCCESS' deploy staging 1.2.3
check 'DEPLOY_POLL_SECONDS sets the wait between polls' has "$calls" 'sleep 3'

RAILWAY_TOKEN=$TOKEN IMAGES='' GITHUB_REPOSITORY=o/app STUB_SERVICES=$STAGING deploy staging 1.2.3
check "with one image, GITHUB_REPOSITORY names it (got $rc)" is "$rc" 0
check 'it deploys that image only' is "$calls" 'railway projectToken
registry ghcr.io/o/app:staging
railway deploy svc-api in env-staging
railway poll dep-svc-api'

# A Railway environment named otherwise is pinned by its id instead.
RAILWAY_TOKEN=$TOKEN RAILWAY_ENVIRONMENT_ID=env-stage STUB_TOKEN_ENV=stage STUB_SERVICES=$STAGING deploy staging 1.2.3
check "a token for the environment RAILWAY_ENVIRONMENT_ID names deploys, whatever its name (got $rc)" is "$rc" 0
check 'in that environment' has "$calls" 'railway deploy svc-web in env-stage'

# --- Refused before anything is deployed -------------------------------------------------------------------------------
# The services answer to :production, so nothing but the token's scope stands between this and a deploy.
RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$PRODUCTION STUB_TOKEN_ENV=staging deploy production 2.0.0
refused 'a staging token used for production'
check 'it names both environments' has "$out" "::error::RAILWAY_TOKEN is scoped to the Railway environment 'staging', not 'production'."
check 'and reads no registry tag' lacks "$calls" 'registry'

RAILWAY_TOKEN=$TOKEN RAILWAY_ENVIRONMENT_ID=env-production STUB_SERVICES=$STAGING deploy staging 1.2.3
refused 'a token scoped to another environment than RAILWAY_ENVIRONMENT_ID'
check 'it names the token scope and the id' has "$out" \
  "::error::RAILWAY_TOKEN is scoped to the Railway environment 'staging' (env-staging), not to RAILWAY_ENVIRONMENT_ID env-production."

RAILWAY_TOKEN=$TOKEN STUB_SERVICES='api|ghcr.io/o/app:staging|' deploy staging 1.2.3
refused 'an image no service runs'
check 'it names the image with no service' has "$out" '::error::No Railway service in staging runs ghcr.io/o/app-web:staging. Nothing was deployed.'

RAILWAY_TOKEN=$TOKEN STUB_SERVICES="$STAGING
api2|ghcr.io/o/app:staging|" deploy staging 1.2.3
refused 'an image two services run'
check 'it names both services' has "$out" '::error::More than one Railway service in staging runs ghcr.io/o/app:staging: api, api2.'

# A service still pinned to an immutable tag, as the adapter once left it, is named with the source to set.
RAILWAY_TOKEN=$TOKEN STUB_SERVICES='api|ghcr.io/o/app:1.2.3|
web|ghcr.io/o/app-web:staging|' deploy staging 1.2.3
refused 'an image whose only service runs another tag of it'
check 'it names that service, what it runs, and the source to point it at' has "$out" \
  '::error::No Railway service in staging runs ghcr.io/o/app:staging: service api runs ghcr.io/o/app:1.2.3; point its source at ghcr.io/o/app:staging. Nothing was deployed.'

RAILWAY_TOKEN=$TOKEN STUB_SERVICES="$STAGING
api-old|ghcr.io/o/app:1.1.0|" deploy staging 1.2.3
check "a service running another tag of a released image is not one of its services (got $rc)" is "$rc" 0
check 'it is left alone' lacks "$calls" 'svc-api-old'

RAILWAY_TOKEN=$TOKEN STUB_SERVICES="$STAGING
worker||o/app" deploy staging 1.2.3
refused 'a service in the environment that builds from a repository'
check 'it names the service and says nothing is built for an environment' has "$out" \
  '::error::worker in staging builds from o/app: every service there runs an image, and nothing is built for an environment.'
check 'and reads no registry tag' lacks "$calls" 'registry'

# Neither image nor repository: an empty service, or one deployed by uploading source (`railway up`).
RAILWAY_TOKEN=$TOKEN STUB_SERVICES="$STAGING
worker||" deploy staging 1.2.3
refused 'a service in the environment that runs no image'
check 'it names the service' has "$out" '::error::worker in staging runs no image: every service there runs an image'

RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_NO_DIGEST=1 deploy staging 1.2.3
refused 'a tag the registry has no digest for'
check 'it names the tag' has "$out" '::error::The registry has no digest for ghcr.io/o/app:staging.'

RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_REGISTRY_FAILS=1 deploy staging 1.2.3
refused 'a tag the registry cannot find'
check 'it names the tag, not just exits' has "$out" '::error::The registry has no digest for ghcr.io/o/app:staging.'

RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_GQL_ERRORS=projectToken deploy staging 1.2.3
refused 'an API answer carrying errors'
check "it shows Railway's error" has "$out" '::error::The Railway API answered with errors: [{"message":"Not Authorized"}].'

RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_CURL_FAILS=projectToken deploy staging 1.2.3
refused 'an API request that fails'
check 'it says the request failed' has "$out" '::error::The Railway API request failed'

RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_NOT_JSON=projectToken deploy staging 1.2.3
refused 'an API answer that is not JSON'
check 'it says the answer was unreadable' has "$out" '::error::The Railway API answered with something other than a JSON object: <html>'

RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_NULL=projectToken deploy staging 1.2.3
refused 'an API answer that is JSON but no object'
check 'it says so, not that the token has another scope' has "$out" '::error::The Railway API answered with something other than a JSON object: null.'

# --- A deployment that does not end up running the release, and stops the images after it ----------------------------
for bad in FAILED CRASHED REMOVED REMOVING SKIPPED NEEDS_APPROVAL WAITING; do
  RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_STATUSES="DEPLOYING $bad" deploy staging 1.2.3
  check "a deployment that ends $bad fails the deploy (got $rc)" is "$rc" 1
  check "$bad: it names the service, deployment and status" \
    has "$out" "::error::api deployment dep-svc-api ended ${bad}. Nothing after it was deployed."
  check "$bad: it stops at that status instead of waiting out the polls" is "$(polls dep-svc-api)" 2
  check "$bad: and deploys nothing after it" lacks "$calls" 'railway deploy svc-web'
done

RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING DEPLOY_POLL_ATTEMPTS=3 STUB_STATUSES='DEPLOYING' deploy staging 1.2.3
check "a deployment that never succeeds fails (got $rc)" is "$rc" 1
check 'after exactly DEPLOY_POLL_ATTEMPTS polls' is "$(polls dep-svc-api)" 3
check 'it says it gave up waiting, and how it waited' \
  has "$out" '::error::api deployment dep-svc-api did not succeed after 3 polls 10 seconds apart (last status DEPLOYING). Nothing after it was deployed.'
check 'it sleeps between polls, not after the last' is "$(grep -c '^sleep 10$' <<<"$calls")" 2
check 'and deploys nothing after it' lacks "$calls" 'railway deploy svc-web'

# SLEEPING is a serverless service that started and then slept: it counts as up, and its digest still has to match.
RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_STATUSES='DEPLOYING SLEEPING' deploy staging 1.2.3
check "a deployment that ends SLEEPING counts as started (got $rc)" is "$rc" 0
check 'it waits no longer than the poll that said so' is "$(polls dep-svc-api)" 2
RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_STATUSES='SLEEPING' STUB_RUN_DIGEST=sha256:stale deploy staging 1.2.3
check "a SLEEPING deployment running another digest fails (got $rc)" is "$rc" 1
check 'it names both digests' has "$out" '::error::api runs sha256:stale, not sha256:app-staging (ghcr.io/o/app:staging).'

# --- A poll Railway does not answer is asked again, a bounded number of times ------------------------------------------
RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_POLL_ERRORS=1 deploy staging 1.2.3
check "one unanswered poll, then an answer, still deploys (got $rc)" is "$rc" 0
check 'it warns that it asked again' \
  has "$out" '::warning::The Railway API answered with errors: [{"message":"Service Unavailable"}]. Asking again (try 1 of 3).'
check 'it polled once more for each' is "$(polls dep-svc-api)" 2
RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_POLL_ERRORS=2 deploy staging 1.2.3
check "two unanswered polls in a row, then an answer, still deploy (got $rc)" is "$rc" 0
# The count is per poll: an answer resets it, so two bad answers before it and two after are four, never three in a row.
RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_STATUSES='DEPLOYING SUCCESS' STUB_POLL_ERROR_AT='1 2 4 5' deploy staging 1.2.3
check "two unanswered polls, an answer, then two more still deploy: each poll gets its own tries (got $rc)" is "$rc" 0
check 'it asked six times' is "$(polls dep-svc-api)" 6
RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_POLL_ERRORS=99 deploy staging 1.2.3
check "a poll Railway never answers fails the deploy (got $rc)" is "$rc" 1
check 'after exactly three tries' is "$(polls dep-svc-api)" 3
check 'it says which try was the last' has "$out" '::warning::The Railway API answered with errors: [{"message":"Service Unavailable"}]. That was try 3 of 3.'
check 'it says so' has "$out" '::error::Railway did not answer a poll of api deployment dep-svc-api 3 times in a row. Nothing after it was deployed.'
check 'and deploys nothing after it' lacks "$calls" 'railway deploy svc-web'
RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_GQL_ERRORS=serviceInstanceDeployV2 deploy staging 1.2.3
check 'a deploy Railway refuses is never sent again' is "$(grep -c 'serviceInstanceDeployV2(' <<<"$argv")" 1

# --- An image after the first fails: the first stays deployed, and the summary lists only it -------------------------
# shellcheck disable=SC2016  # the backticks are Markdown, not a command substitution
API_ONLY='- `api` runs `ghcr.io/o/app:staging` (`sha256:app-staging`), deployment `dep-svc-api`'
RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_STATUSES_web='DEPLOYING FAILED' deploy staging 1.2.3
check "a second image whose deployment fails fails the deploy (got $rc)" is "$rc" 1
check 'it names that service' has "$out" '::error::web deployment dep-svc-web ended FAILED. Nothing after it was deployed.'
check 'the summary lists only the image that deployed' is "$summary" "$API_ONLY"
RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING DEPLOY_POLL_ATTEMPTS=3 STUB_STATUSES_web='DEPLOYING' deploy staging 1.2.3
check "a second image that never succeeds fails the deploy (got $rc)" is "$rc" 1
check 'it names that service' has "$out" '::error::web deployment dep-svc-web did not succeed after 3 polls 10 seconds apart'
check 'the summary lists only the image that deployed' is "$summary" "$API_ONLY"
RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_RUN_DIGEST_web=sha256:stale deploy staging 1.2.3
check "a second image running another digest fails the deploy (got $rc)" is "$rc" 1
check 'it names that service and both digests' \
  has "$out" '::error::web runs sha256:stale, not sha256:app-web-staging (ghcr.io/o/app-web:staging).'
check 'the summary lists only the image that deployed' is "$summary" "$API_ONLY"

RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_RUN_DIGEST=sha256:stale deploy staging 1.2.3
check "a deployment running another digest than the tag fails (got $rc)" is "$rc" 1
check 'it names both digests' has "$out" '::error::api runs sha256:stale, not sha256:app-staging (ghcr.io/o/app:staging).'
check 'it never claims it deployed' lacks "$out" 'Deployed 1.2.3'
check 'and deploys nothing after it' lacks "$calls" 'railway deploy svc-web'

RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_NO_RUN_DIGEST=1 deploy staging 1.2.3
check "a successful deployment that reports no digest fails (got $rc)" is "$rc" 1
check 'it says the digest is unknown' has "$out" '::error::api runs an unknown digest, not sha256:app-staging (ghcr.io/o/app:staging).'

RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_GQL_ERRORS=serviceInstanceDeployV2 deploy staging 1.2.3
check "a deploy Railway refuses fails (got $rc)" is "$rc" 1
check 'and nothing is polled' lacks "$calls" 'railway poll'

RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_NO_DEPLOYMENT=1 deploy staging 1.2.3
check "a deploy that starts no deployment fails (got $rc)" is "$rc" 1
check 'it says so' has "$out" '::error::Railway started no deployment of api.'
check 'and nothing is polled' lacks "$calls" 'railway poll'

# --- A tag held as an index: its own digest, or its linux/amd64 image's, and nothing else ----------------------------
RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_INDEX=1 deploy staging 1.2.3
check "a deployment running the index's linux/amd64 image passes (got $rc)" is "$rc" 0
RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_INDEX=1 STUB_RUN_INDEX=1 deploy staging 1.2.3
check "a deployment running the index itself passes (got $rc)" is "$rc" 0
for other in sha256:arm64-app-staging sha256:attestation-app-staging; do
  RAILWAY_TOKEN=$TOKEN STUB_SERVICES=$STAGING STUB_INDEX=1 STUB_RUN_DIGEST=$other deploy staging 1.2.3
  check "a deployment running another entry of the index ($other) fails (got $rc)" is "$rc" 1
  check "$other: it names what the tag may run" \
    has "$out" "::error::api runs ${other}, not sha256:index-app-staging or sha256:app-staging (ghcr.io/o/app:staging)."
done

# --- Azure: the image reference is lower case, whatever the owner's case -----------------------------------------
# GITHUB_REPOSITORY keeps the owner's capitals ("MarqSpec/App"), and a reference with capitals is invalid: az would fail.
DEPLOY_PROVIDER=azure AZURE_CONTAINER_APP=web GITHUB_REPOSITORY=MarqSpec/App deploy staging 1.2.3
check "azure with a capitalised owner and repository updates the app (got $rc)" is "$rc" 0
check 'it points the app at the lower-case image, on the environment tag' is "$calls"   'az containerapp update --name web-staging --image ghcr.io/marqspec/app:staging'
DEPLOY_PROVIDER=azure AZURE_CONTAINER_APP=web GITHUB_REPOSITORY=o/app deploy production 2.0.0
check 'a name already lower case is unchanged' is "$calls"   'az containerapp update --name web-production --image ghcr.io/o/app:production'
DEPLOY_PROVIDER=azure AZURE_CONTAINER_APP=web deploy staging 1.2.3
check "azure with no GITHUB_REPOSITORY fails and updates nothing (got $rc)" is "$((rc == 1))$calls" 1
check 'it says GITHUB_REPOSITORY is not set' has "$out" 'GITHUB_REPOSITORY is not set'
# Railway's single-image fallback builds the same name.
RAILWAY_TOKEN=$TOKEN IMAGES='' GITHUB_REPOSITORY=MarqSpec/App STUB_SERVICES='api|ghcr.io/marqspec/app:staging|' deploy staging 1.2.3
check "railway's GITHUB_REPOSITORY fallback is lower case too (got $rc)" is "$rc" 0
check 'it reads the lower-case tag' has "$calls" 'registry ghcr.io/marqspec/app:staging'
check 'and never one with capitals' lacks "$calls" 'MarqSpec'
# Only the name built from GITHUB_REPOSITORY is lower-cased: an IMAGES the repository sets is used as it is given.
RAILWAY_TOKEN=$TOKEN IMAGES='ghcr.io/o/App' GITHUB_REPOSITORY=MarqSpec/App STUB_SERVICES='api|ghcr.io/o/App:staging|' deploy staging 1.2.3
check "an explicit IMAGES is not rewritten (got $rc)" is "$rc" 0
check 'it reads the tag as it was given' has "$calls" 'registry ghcr.io/o/App:staging'

# --- A debug run (`bash -x`) traces the script, and never the token ----------------------------------------------------
RAILWAY_TOKEN=$TOKEN DEPLOY_TRACE=1 STUB_SERVICES=$STAGING deploy staging 1.2.3
check "a traced run still deploys (got $rc)" is "$rc" 0
check 'it is traced' has "$out" '+ deploy_railway'
check 'and the trace never shows the token' lacks "$out" "$TOKEN"
RAILWAY_TOKEN=$TOKEN DEPLOY_TRACE=1 STUB_SERVICES=$STAGING STUB_POLL_ERRORS=99 deploy staging 1.2.3
check 'nor does a traced run that fails' lacks "$out" "$TOKEN"

# A suite that silently stops early still prints no failure: hold it to the number of checks it makes.
EXPECTED_CASES=170
check "every case ran ($((cases + 1)) of $EXPECTED_CASES)" is "$((cases + 1))" "$EXPECTED_CASES"

if [ "$fail" -ne 0 ]; then
  printf '\nFAIL: deploy.sh does not deploy exactly the released images to Railway, or does not refuse what it must.\n' >&2
  exit 1
fi
printf '\nOK: deploy.sh deploys every image to its Railway service, waits for each, and checks the digest it runs (%s cases).\n' "$cases"
