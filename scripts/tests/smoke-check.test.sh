#!/usr/bin/env bash
# shellcheck disable=SC2154  # rc, out, curls and sleeps are set by smoke()
# Proves scripts/smoke-check.sh, the check that decides whether a deployment stays or is rolled back: the URL
# named by <ENVIRONMENT>_URL must answer 2xx on HEALTH_PATH within ten attempts; with no URL set it checks nothing
# and passes, warning that the release is unverified. A stub `curl` and a no-op `sleep` (exported
# functions, so the script's six-second waits cost nothing) log every call to a file. No network.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SMOKE="$DIR/../smoke-check.sh"
# A subject that does not parse fails every refusal case for the wrong reason: check it is a program first.
if ! bash -n "$SMOKE"; then echo "::error::FAIL  scripts/smoke-check.sh does not parse" >&2; exit 1; fi
W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT

# curl succeeds from its CURL_OK_AFTER-th call on (1: always; 0: never)
curl() {
  local c=0
  [ -f "$CASE_DIR/curl-n" ] && read -r c < "$CASE_DIR/curl-n"
  c=$((c + 1)); echo "$c" > "$CASE_DIR/curl-n"
  echo "curl $*" >> "$CASE_DIR/curl"
  for a in "$@"; do
    case "$a" in
      @*) printf '%s\n' "headerfile $(cat "${a#@}")" >> "$CASE_DIR/headers" ;;
    esac
  done
  [ "${CURL_OK_AFTER:-1}" -ne 0 ] && [ "$c" -ge "${CURL_OK_AFTER:-1}" ]
}
sleep() { echo "sleep $*" >> "$CASE_DIR/sleeps"; }
export -f curl sleep

fail=0
cases=0
n=0
slurp() { # <var> <file>: the file's text without CRs and trailing newlines, or nothing if it is not there
  local _t=""
  if [ -r "$2" ]; then IFS= read -r -d '' _t < "$2" || true; fi
  _t=${_t//$'\r'/}
  while [[ $_t == *$'\n' ]]; do _t=${_t%$'\n'}; done
  printf -v "$1" '%s' "$_t"
}
# smoke <args...>: runs the script; sets rc, out, curls (the curl calls) and sleeps
smoke() {
  n=$((n + 1)); export CASE_DIR="$W/c$n"
  mkdir -p "$CASE_DIR"
  bash "$SMOKE" "$@" > "$CASE_DIR/out" 2>&1; rc=$?
  slurp out "$CASE_DIR/out"; slurp curls "$CASE_DIR/curl"; slurp sleeps "$CASE_DIR/sleeps"
}
check() { # <what> <command...>: passes when the command succeeds
  local what="$1"; shift
  cases=$((cases + 1))
  if "$@"; then printf 'ok    %s\n' "$what"
  else printf '::error::FAIL  %s\n--- output ---\n%s\n--- curl ---\n%s\n' "$what" "$out" "$curls"; fail=1; fi
}
is()    { [ "$1" = "$2" ]; }
has()   { [[ $1 == *"$2"* ]]; }
lacks() { [[ $1 != *"$2"* ]]; }
calls() { local l; N=0; while IFS= read -r l || [ -n "$l" ]; do [ -n "$l" ] && N=$((N + 1)); done <<<"$1"; }

unset STAGING_URL PRODUCTION_URL QA_URL HEALTH_PATH GITHUB_STEP_SUMMARY DEPLOY_PROVIDER SMOKE_API_KEY

# --- No URL: nothing checked, so a pass that warns the release is unverified ---------------------------------------
smoke staging
check "with no STAGING_URL it passes, so a fresh repository stays green (got $rc)" is "$rc" 0
check 'it warns, not merely notes, that staging is unverified, naming the variable' \
  has "$out" '::warning::staging is unverified: STAGING_URL is not set, so no smoke check ran'
check 'it never reads as a passed check' lacks "$out" 'Smoke check passed'
check 'and it asks nothing of the network' is "$curls" ''
STAGING_URL=https://s.example smoke production
check "STAGING_URL does not stand in for PRODUCTION_URL (got $rc)" is "$rc" 0
check 'production names its own variable' has "$out" '::warning::production is unverified: PRODUCTION_URL is not set'
check 'and asks nothing of the network either' is "$curls" ''
GITHUB_STEP_SUMMARY="$W/summary.md" smoke staging
slurp summary "$W/summary.md"
check 'with a job summary, the warning goes there too' has "$summary" '> [!WARNING]
> staging is unverified: STAGING_URL is not set'
STAGING_URL=https://s.example GITHUB_STEP_SUMMARY="$W/summary-ok.md" smoke staging
check 'a checked URL writes nothing to the summary' is "$([ -e "$W/summary-ok.md" ] && echo written)" ''
QA_URL=https://qa.example smoke qa
check 'any environment name is looked up as <NAME>_URL' has "$curls" 'https://qa.example/health/live'

# --- A selected host with no URL fails the release, instead of warning ---------------------------------------------
DEPLOY_PROVIDER=railway smoke staging
check "a configured provider with no STAGING_URL fails (got $rc)" is "$rc" 1
check 'it errors, rather than warns, and names the variable' \
  has "$out" '::error::staging is unverified and the release fails: DEPLOY_PROVIDER is railway but STAGING_URL is not set'
check 'and it still asks nothing of the network' is "$curls" ''
unset DEPLOY_PROVIDER

# --- A healthy URL -------------------------------------------------------------------------------------------------
STAGING_URL=https://s.example smoke staging
check "a healthy URL passes (got $rc)" is "$rc" 0
check 'with no HEALTH_PATH it checks /health/live' has "$out" 'Smoke check passed: https://s.example/health/live'
calls "$curls"
check 'it asks once when the first answer is 2xx' is "$N" 1
check 'it fails on a non-2xx status and gives up on a silent server' \
  has "$curls" '--fail --silent --show-error --max-time 10 --output /dev/null https://s.example/health/live'
check 'it never waits when the first answer is 2xx' is "$sleeps" ''
STAGING_URL=https://s.example/ HEALTH_PATH=/healthz smoke staging
check 'a trailing slash on the URL is dropped before HEALTH_PATH' has "$out" 'Smoke check passed: https://s.example/healthz'
check 'and the path it asks for is that one' has "$curls" ' https://s.example/healthz'
PRODUCTION_URL=https://p.example HEALTH_PATH=/ready smoke production
check 'production checks PRODUCTION_URL' has "$out" 'Smoke check passed: https://p.example/ready'

# --- A URL that comes up late, and one that never does --------------------------------------------------------------
STAGING_URL=https://s.example CURL_OK_AFTER=3 smoke staging
check "a URL healthy on the third attempt passes (got $rc)" is "$rc" 0
check 'it reports the first failed attempt' has "$out" 'attempt 1/10: https://s.example/health/live not healthy yet'
check 'it reports the second failed attempt' has "$out" 'attempt 2/10: https://s.example/health/live not healthy yet'
check 'it does not report the attempt that succeeded' lacks "$out" 'attempt 3/10'
check 'it waits six seconds after each failed attempt' is "$sleeps" "sleep 6
sleep 6"
check 'and passes on the attempt that succeeds' has "$out" 'Smoke check passed: https://s.example/health/live'

STAGING_URL=https://s.example CURL_OK_AFTER=0 smoke staging
check "a URL that never answers 2xx fails (got $rc)" is "$rc" 1
calls "$curls"
check 'after exactly ten attempts' is "$N" 10
check 'the last attempt is reported' has "$out" 'attempt 10/10: https://s.example/health/live not healthy yet'
calls "$sleeps"
check 'having waited after each of them' is "$N" 10
check 'it says what failed' has "$out" '::error::Smoke check failed: https://s.example/health/live did not answer 2xx.'
check 'and never says it passed' lacks "$out" 'Smoke check passed'

# --- /health/ready sends the key as a header, never on the command line or in the log ------------------------------
STAGING_URL=https://s.example HEALTH_PATH=/health/ready smoke staging
check "readiness without SMOKE_API_KEY fails (got $rc)" is "$rc" 1
check 'it names the secret and the header' has "$out" 'SMOKE_API_KEY is not set'
check 'and it does not call curl' is "$curls" ''
STAGING_URL=https://s.example HEALTH_PATH=/health/ready SMOKE_API_KEY=supersecret smoke staging
check "readiness with a key passes (got $rc)" is "$rc" 0
check 'the curl command line does not contain the key' lacks "$curls" 'supersecret'
check 'the script output does not contain the key' lacks "$out" 'supersecret'
slurp headers "$CASE_DIR/headers"
check 'the header file is X-Api-Key and nothing is in the URL' is "$headers" 'headerfile X-Api-Key: supersecret'
unset SMOKE_API_KEY

# --- Usage ---------------------------------------------------------------------------------------------------------
smoke
check "no environment is refused (got $rc)" is "$((rc != 0))" 1
check 'the refusal names the missing environment' has "$out" 'environment'

# A suite that silently stops early still prints no failure: hold it to the number of checks it makes.
EXPECTED_CASES=43
check "every case ran ($((cases + 1)) of $EXPECTED_CASES)" is "$((cases + 1))" "$EXPECTED_CASES"

if [ "$fail" -ne 0 ]; then
  printf '\nFAIL: smoke-check.sh does not decide a deployment on a 2xx answer within ten attempts.\n' >&2
  exit 1
fi
printf '\nOK: smoke-check.sh passes on a 2xx within ten attempts, or warns the release is unverified with no URL.\n'
