#!/bin/bash

# Forks build unsigned: repo secrets that are not configured arrive as EMPTY
# env vars, and an empty-but-set CSC_LINK makes electron-builder try to
# import a certificate from "" (it dies with "<cwd> not a file" right after
# packaging). Unset them and turn off keychain auto-discovery so the build
# proceeds unsigned; the afterSign hook (build/notarize.js) then ad-hoc
# signs mac apps so they still launch on Apple Silicon.
# (Before set -x so a real certificate value is never echoed to the log.)
if [ -z "${CSC_LINK:-}" ]; then
    unset CSC_LINK CSC_KEY_PASSWORD
    export CSC_IDENTITY_AUTO_DISCOVERY=false
fi

set -x

__dirname="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
electron_version=$(electron --version)

display_usage() {
    npm run electron-builder -- --help
}

if [ $# -le 1 ]; then
    display_usage
    exit 1
fi

if [[ ( $# == "--help") ||  $# == "-h" ]]; then
    display_usage
    exit 0
fi

pushd "$__dirname/../dist/Luban"
echo "Cleaning up \"`pwd`/node_modules\""
rm -rf node_modules
echo "Installing packages..."
npm install --omit=dev
npm dedupe
popd

echo "Rebuild native modules using electron ${electron_version}"

npm run electron-rebuild -- --version=${electron_version:1} --module-dir=dist/Luban --which-module=font-scanner,serialport

cross-env USE_HARD_LINKS=false npm run electron-builder -- "$@"
