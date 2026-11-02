#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec npm start -- "${1:-assistant}"
