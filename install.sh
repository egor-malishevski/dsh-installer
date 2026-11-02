#!/bin/bash
# Установка: curl -fsSL https://raw.githubusercontent.com/egor-malishevski/dsh-installer/main/install.sh | bash
# Только проверка окружения: ... | bash -s -- --check
set -euo pipefail

VERSION='1.0.0'
SHA256='3469fab26c7958848da8454377dae85c2dc3bf9ecc966b590505bb95ff638430'
REPO='egor-malishevski/dsh-installer'

main() {
  if [[ "$(uname -s)" != Darwin ]]; then echo 'DSH Setup поддерживает только macOS.' >&2; exit 1; fi
  if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--check' ) ]]; then echo 'Использование: install.sh [--check]' >&2; exit 1; fi
  local name="dsh-installer-${VERSION}"
  local url="${DSH_INSTALLER_URL:-https://github.com/${REPO}/releases/download/v${VERSION}/${name}.tar.gz}"
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/dsh-setup.XXXXXX")"
  trap 'rm -rf "${WORK}"' EXIT
  trap 'exit 130' INT TERM
  echo "Загрузка DSH Setup ${VERSION}…"
  curl -fsSL --proto '=https,file' -o "${WORK}/setup.tar.gz" "$url"
  local actual
  actual="$(shasum -a 256 "${WORK}/setup.tar.gz" | cut -d' ' -f1)"
  if [[ "${actual}" != "${SHA256}" ]]; then
    echo "Контрольная сумма архива не совпадает (ожидалась ${SHA256}, получена ${actual}). Установка остановлена." >&2
    exit 1
  fi
  tar -xzf "${WORK}/setup.tar.gz" -C "${WORK}"
  echo 'Мастер откроется в браузере. Чтобы остановить установщик, нажмите Ctrl+C.'
  bash "${WORK}/${name}/Install.command" "$@" </dev/null
}

main "$@"
