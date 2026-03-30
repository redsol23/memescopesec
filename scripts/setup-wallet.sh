#!/bin/bash
# Generate a fresh wallet for MemeScope SEC
# Run once on server setup: bash scripts/setup-wallet.sh

set -e

echo "=== MemeScope SEC — Wallet Setup ==="

# Check if .env already has a mnemonic
if [ -f .env ] && grep -q "WALLET_MNEMONIC=.\+" .env 2>/dev/null; then
  echo "WARNING: .env already has a WALLET_MNEMONIC set."
  echo "If you continue, the old mnemonic will be backed up."
  read -p "Continue? (y/N) " confirm
  if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "Aborted."
    exit 0
  fi
  cp .env ".env.backup.$(date +%s)"
  echo "Backed up .env"
fi

# Generate mnemonic and derive wallet address
echo ""
echo "Generating fresh wallet..."

RESULT=$(node -e "
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

const mnemonic = bip39.generateMnemonic(128); // 12 words
const seed = bip39.mnemonicToSeedSync(mnemonic);
const seedHex = seed.toString('hex');

// Derive at index 0 (primary wallet for this agent)
const path = \"m/44'/501'/0'/0'\";
const derived = derivePath(path, seedHex).key;
const keypair = Keypair.fromSeed(derived);
const address = keypair.publicKey.toBase58();

console.log(JSON.stringify({ mnemonic, address }));
")

MNEMONIC=$(echo "$RESULT" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');console.log(JSON.parse(d).mnemonic)")
ADDRESS=$(echo "$RESULT" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');console.log(JSON.parse(d).address)")

echo ""
echo "Wallet Address: $ADDRESS"
echo ""

# Write to .env
if [ -f .env ]; then
  # Update existing
  if grep -q "WALLET_MNEMONIC=" .env; then
    sed -i "s|WALLET_MNEMONIC=.*|WALLET_MNEMONIC=$MNEMONIC|" .env
  else
    echo "WALLET_MNEMONIC=$MNEMONIC" >> .env
  fi
else
  # Create from example
  cp .env.example .env
  sed -i "s|WALLET_MNEMONIC=|WALLET_MNEMONIC=$MNEMONIC|" .env
fi

chmod 600 .env

echo "=== Setup Complete ==="
echo ""
echo "Wallet address: $ADDRESS"
echo "Mnemonic saved to .env (chmod 600)"
echo ""
echo "IMPORTANT: Fund this wallet with SOL before starting the agent."
echo "  solana transfer $ADDRESS 0.5 --url mainnet"
echo ""
echo "Next steps:"
echo "  1. Edit .env to add SOLANA_RPC_URL, HELIUS_API_KEY, etc."
echo "  2. npm run build"
echo "  3. pm2 start ecosystem.config.cjs"
