#!/usr/bin/env bash
# Proves scripts/check-versions.sh, the `Build and test` gate that keeps one SemVer version across every project
# (DEPLOYMENT.md, *Versioning*): it reads the version from Directory.Build.props, or from VERSION
# when there is no .NET code; refuses anything but a release X.Y.Z (no pre-release suffix, no leading zero); and
# fails when a .csproj sets its own <Version> or a package.json (at any indent, or minified; with jq or without) or
# a uv pyproject.toml disagrees. Each case builds a scratch repository around a copy of the script, which finds its
# repository from its own location. No network.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$DIR/../check-versions.sh"
# A subject that does not parse fails every refusal case for the wrong reason: check it is a program first.
if ! bash -n "$CHECK"; then echo "::error::FAIL  scripts/check-versions.sh does not parse" >&2; exit 1; fi
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail=0
cases=0
n=0
REPO=""
# Few processes per case (the script under test starts enough of its own): the copy, the capture of its output and
# the folders are made with bash itself, which is what keeps this test short under Git Bash on Windows.
SCRIPT_TEXT=""
IFS= read -r -d '' SCRIPT_TEXT < "$CHECK" || true
# repo — a fresh scratch repository holding a copy of the script; sets REPO
repo() {
  n=$((n + 1)); REPO="$WORK/r$n"
  mkdir -p "$REPO/scripts"
  printf '%s' "$SCRIPT_TEXT" > "$REPO/scripts/check-versions.sh"
}
# put <path> <text> — a file in REPO, with its folders
put() {
  case "$1" in */*) [ -d "$REPO/${1%/*}" ] || mkdir -p "$REPO/${1%/*}" ;; esac
  printf '%s\n' "$2" > "$REPO/$1"
}
# slurp <var> <file> — the file's text, without CRs (a Windows tool may add them) and trailing newlines
slurp() {
  local _t=""
  IFS= read -r -d '' _t < "$2" || true
  _t=${_t//$'\r'/}
  while [[ $_t == *$'\n' ]]; do _t=${_t%$'\n'}; done
  printf -v "$1" '%s' "$_t"
}
pkg()  { put "$1" "{
  \"name\": \"x\",
  \"version\": \"$2\",
  \"private\": true
}"; }
pyproject() { put "$1" "[project]
name = \"x\"
version = \"$2\"
requires-python = \">=3.12\"

[tool.uv]
managed = true"; }

# expect <exit> <stdout+stderr must contain> <why> [args...] — runs the script in REPO
expect() {
  local want="$1" text="$2" why="$3" out rc
  cases=$((cases + 1))
  shift 3
  bash "$REPO/scripts/check-versions.sh" "$@" > "$WORK/out" 2>&1; rc=$?
  slurp out "$WORK/out"
  if [ "$rc" = "$want" ] && [[ "$out" == *"$text"* ]]; then printf 'ok    %s\n' "$why"
  else printf '::error::FAIL  %s -- wanted exit %s with "%s", got exit %s:\n%s\n' "$why" "$want" "$text" "$rc" "$out"; fail=1; fi
}
# expect_no_stdout <why> [args...] — nothing at all on standard output (errors go to standard error)
expect_no_stdout() {
  local why="$1" out
  cases=$((cases + 1))
  shift
  bash "$REPO/scripts/check-versions.sh" "$@" > "$WORK/out" 2>/dev/null
  slurp out "$WORK/out"
  if [ -z "$out" ]; then printf 'ok    %s\n' "$why"
  else printf '::error::FAIL  %s -- standard output was:\n%s\n' "$why" "$out"; fail=1; fi
}

# --- The source of the version -----------------------------------------------------------------------------------
repo; put VERSION 1.2.3
expect 0 'version 1.2.3: every project agrees' 'a VERSION file with a release version passes'
bash "$REPO/scripts/check-versions.sh" --print > "$WORK/out" 2>&1; slurp out "$WORK/out"
cases=$((cases + 1))
if [ "$out" = "1.2.3" ]; then printf 'ok    %s\n' '--print prints the version and nothing else'
else printf '::error::FAIL  --print prints the version and nothing else -- got: %s\n' "$out"; fail=1; fi
repo; put VERSION '  1.2.3  '
expect 0 'version 1.2.3: every project agrees' 'whitespace around the version in VERSION is ignored'
repo; put Directory.Build.props '<Project><PropertyGroup><Version>2.0.1</Version></PropertyGroup></Project>'
expect 0 'version 2.0.1: every project agrees' 'a <Version> in Directory.Build.props passes'
repo; put Directory.Build.props '<Project><PropertyGroup><Version>2.0.1</Version></PropertyGroup></Project>'; put VERSION 9.9.9
expect 0 'version 2.0.1: every project agrees' 'Directory.Build.props wins over a VERSION file'
repo
expect 1 'No version source' 'no Directory.Build.props and no VERSION fails'

# --- It must be a release X.Y.Z ----------------------------------------------------------------------------------
for bad in 1.2.3-rc.1 1.2.3+build.5 1.2 1.2.3.4 v1.2.3 01.2.3 1.02.3 1.2.03 latest; do
  repo; put VERSION "$bad"
  expect 1 "is not a SemVer release version (X.Y.Z)" "'$bad' is refused"
done
repo; put VERSION ''
expect 1 'is not a SemVer release version' 'an empty VERSION is refused'
repo; put Directory.Build.props '<Project><PropertyGroup><Version>1.0.0-beta</Version></PropertyGroup></Project>'
expect 1 'Directory.Build.props version' 'a pre-release suffix in Directory.Build.props is refused, naming the file'
repo; put VERSION 0.0.0
expect 0 'version 0.0.0' '0.0.0 is a release version'
repo; put VERSION 10.20.30
expect 0 'version 10.20.30' 'multi-digit parts are fine'

# --- A .csproj may not carry its own version ---------------------------------------------------------------------
repo; put VERSION 1.2.3; put src/Api/Api.csproj '<Project><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>'
expect 0 'every project agrees' 'a .csproj without a <Version> passes'
repo; put VERSION 1.2.3; put src/Api/Api.csproj '<Project><PropertyGroup><Version>1.2.3</Version></PropertyGroup></Project>'
expect 1 'src/Api/Api.csproj sets its own <Version>' 'a .csproj with its own <Version> fails, even the same one'
repo; put VERSION 1.2.3; put src/Api/obj/Api.csproj '<Version>9.9.9</Version>'; put src/Api/bin/Api.csproj '<Version>9.9.9</Version>'
expect 0 'every project agrees' 'a .csproj under bin/ or obj/ is not a project'

# --- package.json ------------------------------------------------------------------------------------------------
repo; put VERSION 1.2.3; pkg src/web/package.json 1.2.3; pkg src/admin/package.json 1.2.3
expect 0 'every project agrees' 'package.json files at the repository version pass'
repo; put VERSION 1.2.3; pkg src/web/package.json 1.2.4
expect 1 "src/web/package.json is version '1.2.4', expected '1.2.3' (VERSION)" 'a mismatched package.json fails, naming the file and both versions'
repo; put VERSION 1.2.3; pkg src/web/package.json 1.2.3; pkg src/admin/package.json 1.2.0
expect 1 "src/admin/package.json is version '1.2.0'" 'one mismatched package.json among several fails'
repo; put VERSION 1.2.3; pkg src/web/package.json 1.2.4
expect 1 "expected '1.2.3'" '--print does not hide a mismatch' --print
expect_no_stdout '--print prints no version when a project disagrees' --print
repo; put VERSION 1.2.3; pkg src/web/package.json 1.2.3-rc.1
expect 1 "is version '1.2.3-rc.1'" 'a pre-release package.json fails'
repo; put VERSION 1.2.3; pkg src/web/package.json 1.2.3; pkg src/web/node_modules/dep/package.json 7.7.7
expect 0 'every project agrees' 'a package.json under node_modules is not a project'
repo; put VERSION 1.2.3; put src/web/package.json '{ "name": "x" }'
expect 1 "src/web/package.json is version ''" 'a package.json with no version fails'
# Any indent or none: a formatter or an editor may rewrite the file with tabs, four spaces or on one line.
printf -v tab '\t'
for mode in jq no-jq; do
  if [ "$mode" = no-jq ]; then jq() { return 127; }; export -f jq; fi   # stands in for a machine without jq
  repo; put VERSION 1.2.3; put src/web/package.json "{
${tab}\"name\": \"x\",
${tab}\"version\": \"1.2.3\"
}"
  expect 0 'every project agrees' "a tab-indented package.json is read ($mode)"
  repo; put VERSION 1.2.3; put src/web/package.json '{
    "name": "x",
    "version" : "1.2.4",
    "private": true
}'
  expect 1 "src/web/package.json is version '1.2.4'" "a four-space package.json is read, space before the colon too ($mode)"
  repo; put VERSION 1.2.3; put src/web/package.json '{"name":"x","version":"1.2.3","dependencies":{"a":"^2.0.0"}}'
  expect 0 'every project agrees' "a minified package.json is read ($mode)"
  repo; put VERSION 1.2.3; put src/web/package.json '{"name":"x","version":"1.2.0"}'
  expect 1 "src/web/package.json is version '1.2.0'" "a minified package.json that disagrees fails ($mode)"
  repo; put VERSION 1.2.3; put src/web/package.json '{"name":"x","private":true}'
  expect 1 "src/web/package.json is version ''" "a minified package.json with no version fails ($mode)"
done
unset -f jq
repo; put VERSION 1.2.3; put src/web/package.json '{"name":"x","config":{"version":"9.9.9"},"version":"1.2.3"}'
expect 0 'every project agrees' 'with jq, only the top-level version counts, not one nested before it'

repo; put Directory.Build.props '<Project><PropertyGroup><Version>3.1.4</Version></PropertyGroup></Project>'; pkg src/web/package.json 3.1.4
expect 0 'version 3.1.4: every project agrees' 'a package.json beside Directory.Build.props agrees with it'
repo; put Directory.Build.props '<Project><PropertyGroup><Version>3.1.4</Version></PropertyGroup></Project>'; pkg src/web/package.json 3.1.5
expect 1 "expected '3.1.4' (Directory.Build.props)" 'a mismatch names Directory.Build.props as the source'

# --- uv workspace members ----------------------------------------------------------------------------------------
repo; put VERSION 1.2.3; pyproject src/api/pyproject.toml 1.2.3
expect 0 'every project agrees' 'a pyproject.toml at the repository version passes'
repo; put VERSION 1.2.3; pyproject src/api/pyproject.toml 1.2.4
expect 1 "src/api/pyproject.toml is version '1.2.4', expected '1.2.3' (VERSION)" 'a mismatched pyproject.toml fails'
repo; put VERSION 1.2.3; put src/pyproject.toml '[tool.uv.workspace]
members = ["api"]'
expect 0 'every project agrees' 'a workspace root with no [project] table has no version to check'
repo; put VERSION 1.2.3; pyproject src/api/.venv/lib/pyproject.toml 0.0.1
expect 0 'every project agrees' 'a pyproject.toml under .venv is not a project'
repo; put VERSION 1.2.3; put src/api/pyproject.toml '[project]
name = "x"
requires-python = ">=3.12"

[tool.other]
version = "1.2.3"'
expect 1 "src/api/pyproject.toml is version ''" 'a [project] table with no version fails (a version in another table does not count)'

# --- Generated and dependency folders are not projects -------------------------------------------------------------
repo; put Directory.Build.props '<Project><PropertyGroup><Version>3.1.4</Version></PropertyGroup></Project>'; pkg src/web/package.json 3.1.4
pkg src/web/.next/package.json 0.0.1; pkg src/web/.next/server/package.json 0.0.2; pkg src/web/node_modules/next/package.json 15.0.0
pkg src/web/dist/package.json 0.0.3; put src/Api/bin/Release/Svc.csproj '<Version>9.9.9</Version>'; put src/Api/obj/Svc.csproj '<Version>9.9.9</Version>'
pyproject src/api/.venv/x/pyproject.toml 0.0.1
expect 0 'version 3.1.4: every project agrees' 'manifests under .next, node_modules, dist, bin, obj and .venv are not projects'
pkg src/web/package.json 3.1.5
expect 1 "src/web/package.json is version '3.1.5'" 'beside those folders, a mismatch in the real manifest still fails'
repo; put VERSION 1.2.3; pkg src/next-app/package.json 1.2.4
expect 1 "src/next-app/package.json is version '1.2.4'" 'a project folder whose name only resembles a pruned one is still read'

# --- Every project is reported, not just the first ---------------------------------------------------------------
repo; put VERSION 1.2.3; pkg src/web/package.json 1.0.0; pyproject src/api/pyproject.toml 2.0.0
put src/dotnet/Svc.csproj '<Version>1.2.3</Version>'   # folder names that differ by more than case: Windows folds case
expect 1 "src/web/package.json is version '1.0.0'" 'all disagreeing projects are named: the package.json'
expect 1 "src/api/pyproject.toml is version '2.0.0'" 'all disagreeing projects are named: the pyproject.toml'
expect 1 'src/dotnet/Svc.csproj sets its own <Version>' 'all disagreeing projects are named: the .csproj'

# A suite that silently stops early still prints no failure: hold it to the number of checks it makes.
EXPECTED_CASES=55
if [ "$((cases + 1))" = "$EXPECTED_CASES" ]; then printf 'ok    %s\n' "every case ran ($((cases + 1)) of $EXPECTED_CASES)"
else printf '::error::FAIL  %s\n' "every case ran ($((cases + 1)) of $EXPECTED_CASES)"; fail=1; fi

if [ "$fail" -ne 0 ]; then
  printf '\nFAIL: check-versions.sh does not hold every project to one release version.\n' >&2
  exit 1
fi
printf '\nOK: check-versions.sh holds every project to one X.Y.Z release version.\n'
