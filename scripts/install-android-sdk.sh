#!/usr/bin/env bash
# Installs the Android command-line tools, platform 36 and build-tools 36.0.0.
# android.yml runs this for the debug APK job.
# Writes ANDROID_HOME and ANDROID_SDK_ROOT to GITHUB_ENV when that file is set.
set -euo pipefail

sdk_root="${ANDROID_SDK_ROOT:-${RUNNER_TEMP:-/tmp}/android-sdk}"
tools_zip="${RUNNER_TEMP:-/tmp}/commandlinetools.zip"
tools_url="https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip"
tools_sha="7ec965280a073311c339e571cd5de778b9975026cfcbe79f2b1cdcb1e15317ee"

mkdir -p "${sdk_root}/cmdline-tools"
curl -fsSL -o "${tools_zip}" "${tools_url}"
echo "${tools_sha}  ${tools_zip}" | sha256sum -c
unzip -q "${tools_zip}" -d "${sdk_root}/cmdline-tools"
rm -f "${tools_zip}"
mv "${sdk_root}/cmdline-tools/cmdline-tools" "${sdk_root}/cmdline-tools/latest"

sdkmanager="${sdk_root}/cmdline-tools/latest/bin/sdkmanager"
# sdkmanager's status is what matters. pipefail would also see `yes` die with SIGPIPE.
set +o pipefail
yes | "${sdkmanager}" --sdk_root="${sdk_root}" --licenses
license_status=$?
set -o pipefail
if [ "${license_status}" -ne 0 ]; then
  echo "sdkmanager --licenses failed with status ${license_status}"
  exit "${license_status}"
fi
"${sdkmanager}" --sdk_root="${sdk_root}" --install "platforms;android-36" "build-tools;36.0.0" "platform-tools"

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "ANDROID_HOME=${sdk_root}" >> "${GITHUB_ENV}"
  echo "ANDROID_SDK_ROOT=${sdk_root}" >> "${GITHUB_ENV}"
fi
export ANDROID_HOME="${sdk_root}"
export ANDROID_SDK_ROOT="${sdk_root}"
