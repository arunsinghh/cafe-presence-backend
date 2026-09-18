#!/usr/bin/env bash
set -e
echo "This setup package is distributed with the cafe-presence-backend folder. Copy the folder to an empty workspace, then run npm install."
cd "$(dirname "$0")"
npm install
echo "Phase 1 project ready: $(pwd)"
