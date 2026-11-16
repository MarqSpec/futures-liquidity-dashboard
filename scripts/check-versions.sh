#!/usr/bin/env bash
# Every project in the repository carries one SemVer version (DEPLOYMENT.md, *Versioning*).
# The source is <Version> in Directory.Build.props, or the VERSION file when there is no .NET code.
# Usage: scripts/check-versions.sh           fail unless every project agrees and the version is X.Y.Z
#        scripts/check-versions.sh --print   print the version (after the same checks)
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f Directory.Build.props ]]; then
  source_file=Directory.Build.props
  version="$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' Directory.Build.props | head -n1)"
elif [[ -f VERSION ]]; then
  source_file=VERSION
  version="$(tr -d '[:space:]' < VERSION)"
else
  echo "::error::No version source: add <Version> to Directory.Build.props or a VERSION file." >&2
  exit 1
fi

# main carries a plain release version X.Y.Z - no pre-release suffix; images are tagged with it as is.
if [[ ! "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "::error::${source_file} version '${version}' is not a SemVer release version (X.Y.Z)." >&2
  exit 1
fi

# The project's own manifests only: generated and dependency folders are pruned, so a local `next build`
# (src/web/.next), an installed node_modules, a .NET bin/obj or a .venv never reads as a project. The list
# matches the build output .dockerignore keeps out of the image.
GENERATED_DIRS=(node_modules .next bin obj .venv dist TestResults)
find_manifests() { # find_manifests <name-pattern>: every matching file under src outside GENERATED_DIRS
  local prune=() d
  for d in "${GENERATED_DIRS[@]}"; do prune+=(-name "$d" -o); done
  unset 'prune[${#prune[@]}-1]'
  find src -type d \( "${prune[@]}" \) -prune -o -type f -name "$1" -print 2>/dev/null
}

status=0
# A .csproj may not override the repository version.
while IFS= read -r proj; do
  if grep -q '<Version>' "$proj"; then
    echo "::error::${proj} sets its own <Version>; the repository version lives in ${source_file}." >&2
    status=1
  fi
done < <(find_manifests '*.csproj')

# A package.json's top-level "version", however the file is indented or minified: jq reads it when it is installed
# (and the file is valid JSON); otherwise a bash regex takes the first "version": "..." pair in the file, which in
# a package.json is the top-level one (npm and pnpm write it right after "name").
pkg_version() { # <file>: prints the version, or nothing
  local text="" v="" re='"version"[[:space:]]*:[[:space:]]*"([^"]*)"'
  if command -v jq >/dev/null 2>&1 \
     && v="$(jq -r 'if type == "object" and (.version | type) == "string" then .version else "" end' "$1" 2>/dev/null)"; then
    printf '%s' "${v%$'\r'}"   # a Windows jq ends the line with a CR
    return
  fi
  IFS= read -r -d '' text < "$1" || true
  if [[ $text =~ $re ]]; then printf '%s' "${BASH_REMATCH[1]}"; fi
}
while IFS= read -r pkg; do
  pv="$(pkg_version "$pkg")"
  if [[ "$pv" != "$version" ]]; then
    echo "::error::${pkg} is version '${pv}', expected '${version}' (${source_file})." >&2
    status=1
  fi
done < <(find_manifests package.json)

# Every uv workspace member's pyproject.toml carries the repository version (set with `uv version --package`).
# A file with no [project] table — a workspace root — is not a package and has no version to check.
while IFS= read -r py; do
  grep -q '^\[project\]' "$py" || continue
  pv="$(sed -n '/^\[project\]/,/^\[/{s/^version = "\(.*\)"$/\1/p}' "$py" | head -n1)"
  if [[ "$pv" != "$version" ]]; then
    echo "::error::${py} is version '${pv}', expected '${version}' (${source_file})." >&2
    status=1
  fi
done < <(find_manifests pyproject.toml)

[[ $status -eq 0 ]] || exit 1
if [[ "${1:-}" == "--print" ]]; then echo "$version"; else echo "version ${version}: every project agrees"; fi
