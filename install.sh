#!/bin/bash
# Установка: curl -fsSL https://raw.githubusercontent.com/egor-malishevski/dsh-installer/main/install.sh | bash
# Только проверка окружения: ... | bash -s -- --check
set -euo pipefail

VERSION='1.3.4'
SHA256='fc481d2abe3dff0346f921db0ab6e9827c923c52d3c92cdee05e8ec04b48d88b'
REPO='egor-malishevski/dsh-installer'

# Официальная сборка DeepSeek Harness (Apple Silicon) и её SHA-512 из фида обновлений DeepSeek.
HARNESS_VERSION='0.2.1-rc.5'
HARNESS_URL='https://download.deepseek.com/dsh-desk/bin/mac-arm64/deepseek-harness-0.2.1-rc.5-mac-arm64.zip'
HARNESS_SHA512='SPXR+TMC5+7v9R544aKgA2CkDrLr2XyNL/35/NuxGBbP5nrSTEGMurNRAi+R1RSlcWZm3KNdySAt0RS8Qizv9g=='
HARNESS_TEAM='NAN929V4UM'
HARNESS_BUNDLE_ID='com.deepseek.dsh'

fail() { echo "$1" >&2; exit 1; }

plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null || true; }

install_harness() {
  local app="${DSH_HARNESS_APP:-/Applications/DeepSeek Harness.app}"
  if [[ -e "$app" ]]; then
    local current
    current="$(plist "$app" CFBundleShortVersionString)"
    if [[ "$current" != "$HARNESS_VERSION" ]]; then
      echo "Внимание: установлен DeepSeek Harness ${current:-неизвестной версии}, мастер поддерживает только ${HARNESS_VERSION}. Существующее приложение не изменяется." >&2
    fi
    return 0
  fi
  if [[ "$(uname -m)" != arm64 ]] && [[ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" != 1 ]]; then
    fail "DeepSeek Harness ${HARNESS_VERSION} выпущен только для Apple Silicon. Для Intel поддерживаемой сборки нет."
  fi
  [[ -w "$(dirname "$app")" ]] || fail "Нет прав на запись в $(dirname "$app"). Войдите под учётной записью администратора."
  echo "DeepSeek Harness не найден. Загрузка официальной сборки ${HARNESS_VERSION} с download.deepseek.com (~350 МБ)…"
  curl -fL --progress-bar --proto '=https,file' -o "${WORK}/harness.zip" "${DSH_HARNESS_URL:-$HARNESS_URL}" \
    || fail "Не удалось скачать DeepSeek Harness ${HARNESS_VERSION}. Возможно, DeepSeek уже удалил эту сборку. Установите Harness ${HARNESS_VERSION} вручную и повторите команду."
  local actual
  actual="$(openssl dgst -sha512 -binary "${WORK}/harness.zip" | base64)"
  [[ "$actual" == "$HARNESS_SHA512" ]] || fail 'Контрольная сумма DeepSeek Harness не совпадает с опубликованной DeepSeek. Установка остановлена.'
  mkdir "${WORK}/harness"
  ditto -x -k "${WORK}/harness.zip" "${WORK}/harness"
  local staged="${WORK}/harness/DeepSeek Harness.app"
  [[ -d "$staged" ]] || fail 'В архиве DeepSeek Harness нет приложения. Установка остановлена.'
  [[ "$(plist "$staged" CFBundleIdentifier)" == "$HARNESS_BUNDLE_ID" && "$(plist "$staged" CFBundleShortVersionString)" == "$HARNESS_VERSION" ]] \
    || fail 'Версия или идентификатор скачанного DeepSeek Harness не совпадают. Установка остановлена.'
  local signature
  signature="$(codesign -dv "$staged" 2>&1 || true)"
  codesign --verify --deep --strict "$staged" 2>/dev/null && [[ $'\n'"$signature"$'\n' == *$'\nTeamIdentifier='"${HARNESS_TEAM}"$'\n'* ]] \
    || fail 'Подпись DeepSeek Harness не прошла проверку. Установка остановлена.'
  mv "$staged" "$app"
  echo "DeepSeek Harness ${HARNESS_VERSION} установлен в $(dirname "$app")."
}

main() {
  [[ "$(uname -s)" == Darwin ]] || fail 'DSH Setup поддерживает только macOS.'
  if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--check' ) ]]; then fail 'Использование: install.sh [--check]'; fi
  local name="dsh-installer-${VERSION}"
  local url="${DSH_INSTALLER_URL:-https://github.com/${REPO}/releases/download/v${VERSION}/${name}.tar.gz}"
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/dsh-setup.XXXXXX")"
  trap 'rm -rf "${WORK}"' EXIT
  trap 'exit 130' INT TERM
  [[ $# -eq 0 ]] && install_harness
  echo "Загрузка DSH Setup ${VERSION}…"
  curl -fsSL --proto '=https,file' -o "${WORK}/setup.tar.gz" "$url"
  local actual
  actual="$(shasum -a 256 "${WORK}/setup.tar.gz" | cut -d' ' -f1)"
  if [[ "${actual}" != "${SHA256}" ]]; then
    fail "Контрольная сумма архива не совпадает (ожидалась ${SHA256}, получена ${actual}). Установка остановлена."
  fi
  tar -xzf "${WORK}/setup.tar.gz" -C "${WORK}"
  [[ $# -eq 0 ]] && echo 'Мастер откроется в браузере. Чтобы остановить установщик, нажмите Ctrl+C.'
  bash "${WORK}/${name}/Install.command" "$@" </dev/null
}

main "$@"
