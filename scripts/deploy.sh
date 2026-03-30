#!/bin/bash
# MemeScope SEC — Deploy to Hetzner g2e box
set -e

echo "=== MemeScope SEC Deploy ==="

cd ~/memescopesec

echo "[1/4] Pulling latest..."
git fetch origin
git reset --hard origin/main

echo "[2/4] Installing dependencies..."
npm install --production

echo "[3/4] Building..."
npx tsc
cp -r src/public dist/

echo "[4/4] Restarting PM2..."
pm2 startOrRestart ecosystem.config.cjs --update-env

echo "=== Deploy complete ==="
pm2 list | grep memescopesec
