/**
 * MemeScope SEC — Main Entrypoint
 *
 * Monitors KOL wallets on Solana for pump.fun buys,
 * mirrors trades with tiered position sizing, tracks PnL per KOL.
 */

import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { logger } from './utils/logger.js';
import { deriveSolanaKeypair } from './utils/wallet.js';
import { getDb, getCollection } from './utils/mongodb.js';
import { config, getPositionSizeForTier } from './config.js';
import { sendTelegramAlert } from './utils/telegram.js';
import { WalletMonitor } from './services/wallet-monitor.js';
import { MirrorTrader } from './services/mirror-trader.js';
import { PositionManager } from './services/position-manager.js';
import { PnlTracker } from './services/pnl-tracker.js';
import { HeliusWebhookManager } from './services/helius-webhook.js';
import { CreatorFeeCollector } from './services/creator-fee-collector.js';
import { setupApiRoutes } from './routes/api-routes.js';
import type { KolTrackerStateDoc } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  logger.info('[MemeScope] Starting MemeScope SEC...');

  // 1. Derive wallet
  const mnemonic = process.env.WALLET_MNEMONIC;
  if (!mnemonic) { logger.error('[MemeScope] WALLET_MNEMONIC not set.'); process.exit(1); }

  const keypair = deriveSolanaKeypair(mnemonic, config.walletIndex);
  if (!keypair) { logger.error(`[MemeScope] Failed to derive wallet at index ${config.walletIndex}`); process.exit(1); }

  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) { logger.error('[MemeScope] SOLANA_RPC_URL not set.'); process.exit(1); }

  const connection = new Connection(rpcUrl, 'confirmed');
  logger.info(`[MemeScope] Wallet: ${keypair.publicKey.toBase58()} (index ${config.walletIndex})`);

  const balance = await connection.getBalance(keypair.publicKey);
  const balanceSOL = balance / LAMPORTS_PER_SOL;
  logger.info(`[MemeScope] Wallet balance: ${balanceSOL.toFixed(4)} SOL`);

  if (balanceSOL < 0.01) {
    logger.warn('[MemeScope] Wallet balance very low! Fund the wallet before trading.');
  }

  // 2. MongoDB
  await getDb();
  logger.info('[MemeScope] MongoDB connected.');

  const tradesCol = await getCollection('kol_trades');
  await tradesCol.createIndex({ kolTxSignature: 1 }, { unique: true });
  await tradesCol.createIndex({ status: 1 });
  await tradesCol.createIndex({ kolAddress: 1 });
  await tradesCol.createIndex({ entryAt: -1 });

  const walletsCol = await getCollection('kol_wallets');
  await walletsCol.createIndex({ address: 1 }, { unique: true });

  const stateCol = await getCollection<KolTrackerStateDoc>('kol_tracker_state');
  await stateCol.updateOne(
    { _id: 'kol_tracker_state' as any },
    { $setOnInsert: { lastPollPerWallet: {}, startedAt: new Date(), walletBalanceSOL: balanceSOL, totalRealizedPnlSOL: 0, currentTier: 0 } },
    { upsert: true },
  );

  // 3. Initialize services
  const pnlTracker = new PnlTracker();
  const mirrorTrader = new MirrorTrader(connection, keypair, pnlTracker);
  const positionManager = new PositionManager(connection, mirrorTrader, pnlTracker);
  const walletMonitor = new WalletMonitor(connection, mirrorTrader);
  const heliusWebhook = new HeliusWebhookManager(connection, mirrorTrader);
  const feeCollector = new CreatorFeeCollector(connection, keypair);

  // 4. Express server
  const app = express();
  app.use(express.json());
  app.use('/public', express.static(join(__dirname, 'public')));
  app.get('/', (_req, res) => res.sendFile(join(__dirname, 'public', 'kol-tracker.html')));

  // Helius webhook receiver endpoint
  app.post('/api/helius/webhook', async (req, res) => {
    // Verify auth header
    const authHeader = req.headers['authorization'];
    if (config.heliusWebhookSecret && authHeader !== config.heliusWebhookSecret) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const events = Array.isArray(req.body) ? req.body : [req.body];
    // Respond immediately so Helius doesn't retry
    res.status(200).json({ received: events.length });

    // Process async
    heliusWebhook.handleWebhookEvent(events).catch(err => {
      logger.error(`[Helius] Webhook processing error: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  setupApiRoutes(app, walletMonitor, mirrorTrader, positionManager, pnlTracker, heliusWebhook, feeCollector);

  app.get('/api/health', async (_req, res) => {
    const state = await stateCol.findOne({ _id: 'kol_tracker_state' as any });
    const currentBalance = await connection.getBalance(keypair.publicKey);
    res.json({
      status: 'ok', uptime: process.uptime(),
      wallet: keypair.publicKey.toBase58(),
      balanceSOL: currentBalance / LAMPORTS_PER_SOL,
      currentTier: state?.currentTier ?? 0,
      positionSize: getPositionSizeForTier(state?.currentTier ?? 0),
      mode: heliusWebhook.isConfigured() ? 'webhook' : 'polling',
      monitoring: walletMonitor.isRunning(),
    });
  });

  const server = app.listen(config.port, () => {
    logger.info(`[MemeScope] Dashboard: http://localhost:${config.port}/`);
  });

  // 5. Start monitoring — Helius webhooks if configured, polling fallback
  if (heliusWebhook.isConfigured()) {
    const webhookUrl = `http://localhost:${config.port}/api/helius/webhook`;
    const ok = await heliusWebhook.setupWebhook(webhookUrl);
    if (ok) {
      logger.info('[MemeScope] Using Helius webhooks (sub-second detection)');
    } else {
      logger.info('[MemeScope] Helius webhook setup failed — falling back to polling');
      await walletMonitor.start();
    }
  } else {
    logger.info('[MemeScope] No Helius API key — using polling mode');
    await walletMonitor.start();
  }

  positionManager.start();

  // Start creator fee collection if agent token is configured
  if (feeCollector.isConfigured()) {
    feeCollector.start();
    logger.info(`[MemeScope] Creator fee collector active (${config.agentBuybackBps / 100}% buyback)`);
  } else {
    logger.info('[MemeScope] No AGENT_TOKEN_MINT — fee collector disabled');
  }

  logger.info('[MemeScope] All systems online.');
  if (process.send) process.send('ready');

  const shutdown = async () => {
    logger.info('[MemeScope] Shutting down...');
    walletMonitor.stop();
    positionManager.stop();
    feeCollector.stop();
    await heliusWebhook.cleanup();
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Alert on uncaught errors instead of crashing silently
  process.on('uncaughtException', async (err) => {
    logger.error(`[MemeScope] Uncaught exception: ${err.message}`);
    await sendTelegramAlert(`CRASH: Uncaught exception\n${err.message}`);
  });
  process.on('unhandledRejection', async (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error(`[MemeScope] Unhandled rejection: ${msg}`);
    await sendTelegramAlert(`ERROR: Unhandled rejection\n${msg}`);
  });
}

main().catch((err) => {
  logger.error(`[MemeScope] Fatal: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error) logger.error(err.stack || '');
  process.exit(1);
});
