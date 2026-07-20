#!/usr/bin/env bash
# Builds the Chrome Web Store package — ONLY the extension files.
# Everything else in this repo (backend functions, landing page, node_modules)
# must stay out of the upload.
set -e
cd "$(dirname "$0")"
rm -rf dist fitmatch-extension.zip
mkdir -p dist
cp manifest.json popup.html popup.css popup.js engine.js i18n.js scrape.js background.js dist/
cp -R icons _locales dist/
(cd dist && zip -rq ../fitmatch-extension.zip . -x ".*")
rm -rf dist
echo "Built fitmatch-extension.zip ($(du -h fitmatch-extension.zip | cut -f1))"
