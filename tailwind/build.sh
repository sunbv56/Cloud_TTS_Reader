#!/usr/bin/env bash
# app.css is served with an immutable cache, so its ?v= is the content hash.
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --no-audit --no-fund
npm run build
hash=$(sha256sum ../static/css/app.css | cut -c1-10)
sed -i -E "s#(/static/css/app\.css\?v=)[0-9a-z]+#\1${hash}#" ../static/index.html ../static/sw.js
echo "app.css?v=${hash}"
