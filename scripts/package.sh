#!/bin/bash
# Собирает dist/dsh-installer-<version>.tar.gz и вписывает его SHA-256 в install.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(node -p 'require("./package.json").version')"
NAME="dsh-installer-$VERSION"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p dist "$STAGE/$NAME"
cp -R Install.command server.js package.json README.md lib payload "$STAGE/$NAME/"
mkdir "$STAGE/$NAME/docs"
cp docs/update-recovery.md "$STAGE/$NAME/docs/"
mkdir "$STAGE/$NAME/ui"
cp ui/*.html ui/*.css ui/*.js ui/*.svg ui/package.json "$STAGE/$NAME/ui/"
find "$STAGE" -name .DS_Store -delete
COPYFILE_DISABLE=1 tar --exclude='*/node_modules' --exclude="$NAME/dist" --exclude='*/tmp' --exclude='*/.env' --exclude='*/.env.*' --exclude='*.pem' --exclude='*.key' -czf "dist/$NAME.tar.gz" --no-xattrs -C "$STAGE" "$NAME"
SHA="$(shasum -a 256 "dist/$NAME.tar.gz" | cut -d' ' -f1)"
echo "$SHA  $NAME.tar.gz" > "dist/$NAME.tar.gz.sha256"
perl -pi -e "s/^VERSION=.*/VERSION='$VERSION'/; s/^SHA256=.*/SHA256='$SHA'/" install.sh
echo "dist/$NAME.tar.gz $SHA"
