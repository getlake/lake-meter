#!/usr/bin/env bash
# Simulated Claude Code session for a GIF: plan breakdown → cap prompt → receipt. No account needed.
cd "$(dirname "$0")/.." && DEMO_DELAY=${DEMO_DELAY:-900} CAP=${CAP:-1} node scripts/simulate.js
