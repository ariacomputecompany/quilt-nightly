#!/usr/bin/env bash
set -euo pipefail

AEGIS_REPO_URL="${AEGIS_REPO_URL:-https://github.com/ariacomputecompany/aegis.git}"
AEGIS_GIT_REF="${AEGIS_GIT_REF:-linux}"
AEGIS_SRC_DIR="${AEGIS_SRC_DIR:-/opt/aegis-src}"
APT_PACKAGES=(
  build-essential
  clang
  lld
  ninja-build
  pkg-config
  curl
  ca-certificates
  bzip2
  tar
  patchelf
  git
  npm
  xdg-utils
  x11vnc
  xvfb
  libasound2-dev
  libatk-bridge2.0-dev
  libatk1.0-dev
  libatspi2.0-dev
  libcairo2-dev
  libcups2-dev
  libdbus-1-dev
  libdrm-dev
  libegl1-mesa-dev
  libgbm-dev
  libgl1-mesa-dev
  libgles2-mesa-dev
  libglib2.0-dev
  gtk3-nocsd
  libgtk-3-dev
  libnss3-dev
  libpango1.0-dev
  libx11-dev
  libx11-xcb-dev
  libxcb-randr0-dev
  libxcb-shm0-dev
  libxcb-xfixes0-dev
  libxcb1-dev
  libxcomposite-dev
  libxdamage-dev
  libxext-dev
  libxfixes-dev
  libxi-dev
  libxkbcommon-dev
  libxkbcommon-x11-dev
  libxrandr-dev
  libxrender-dev
  libxshmfence-dev
  libxtst-dev
)

if command -v aegis >/dev/null 2>&1; then
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive

mkdir -p /var/lib/apt/lists/partial
mkdir -p /var/cache/apt/archives/partial

apt-get update
apt-get install -y --no-install-recommends "${APT_PACKAGES[@]}"
rm -rf /var/lib/apt/lists/*

if ! command -v rustup >/dev/null 2>&1; then
  curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal
fi

export PATH="/root/.cargo/bin:${PATH}"
rustup toolchain install stable --profile minimal
rustup default stable

if [[ ! -d "${AEGIS_SRC_DIR}/.git" ]]; then
  rm -rf "${AEGIS_SRC_DIR}"
  git clone --branch "${AEGIS_GIT_REF}" --depth 1 "${AEGIS_REPO_URL}" "${AEGIS_SRC_DIR}"
fi

cd "${AEGIS_SRC_DIR}"
export TAR_OPTIONS="${TAR_OPTIONS:+${TAR_OPTIONS} }--no-same-owner"
bash scripts/bootstrap_linux_native.sh
bash install.sh
