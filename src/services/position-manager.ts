/**
 * Position Manager — Checks open positions against exit targets.
 */

import { Connection } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { getCollection } from '../utils/mongodb.js';
import { config } from '../config.js';
import type { MirrorTrader } from './mirror-trader.js';
import type { PnlTracker } from './pnl-tracker.js';
import type { KolTradeDoc, KolWalletDoc } from '../types.js';

export class PositionManager {
  private connection: Connection;
  private mirrorTrader: MirrorTrader;
  private pnlTracker: PnlTracker;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(connection: Connection, mirrorTrader: MirrorTrader, pnlTracker: PnlTracker) {
    this.connection = connection;
    this.mirrorTrader = mirrorTrader;
    this.pnlTracker = pnlTracker;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info(`[PositionManager] Exit checks every ${config.positionCheckIntervalMs / 1000}s`);
    this.checkTimer = setInterval(async () => {
      try { await this.checkPositions(); }
      catch (err) { logger.error(`[PositionManager] Check error: ${err instanceof Error ? err.message : String(err)}`); }
    }, config.positionCheckIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.checkTimer) { clearInterval(this.checkTimer); this.checkTimer = null; }
    logger.info('[PositionManager] Stopped.');
  }

  private async checkPositions(): Promise<void> {
    await this.pnlTracker.updateAllOpenPositions();

    const tradesCol = await getCollection<KolTradeDoc>('kol_trades');
    const walletsCol = await getCollection<KolWalletDoc>('kol_wallets');
    const openTrades = await tradesCol.find({ status: { $in: ['open', 'partial_exit'] } }).toArray();
    if (openTrades.length === 0) return;

    for (const trade of openTrades) {
      try { await this.evaluatePosition(trade, walletsCol); }
      catch (err) { logger.warn(`[PositionManager] Error on ${trade.tokenMint.slice(0, 8)}...: ${err instanceof Error ? err.message : String(err)}`); }
    }
  }

  private async evaluatePosition(
    trade: KolTradeDoc,
    walletsCol: Awaited<ReturnType<typeof getCollection<KolWalletDoc>>>,
  ): Promise<void> {
    const kol = await walletsCol.findOne({ address: trade.kolAddress });
    const exitStrategy = kol?.exitStrategy ?? config.defaultExitStrategy;

    const currentPrice = trade.currentPricePerToken;
    const entryPrice = trade.entryPricePerToken;
    if (entryPrice <= 0 || currentPrice <= 0) return;

    const multiplier = currentPrice / entryPrice;
    const totalSold = trade.exits.reduce((sum, e) => sum + e.tokensSold, 0);
    const remaining = trade.entryTokenAmount - totalSold;
    if (remaining <= 0.01) return;

    const holdMinutes = (Date.now() - new Date(trade.entryAt).getTime()) / (1000 * 60);

    // Time limit — force sell everything
    if (holdMinutes >= exitStrategy.maxHoldMinutes) {
      logger.info(`[PositionManager] Time limit: ${trade.tokenMint.slice(0, 8)}... (${holdMinutes.toFixed(0)}m)`);
      await this.mirrorTrader.executeSell(trade, remaining, 'time_limit');
      return;
    }

    // Target 2 — sell remaining
    if (trade.status === 'partial_exit' && multiplier >= exitStrategy.target2Multiplier) {
      logger.info(`[PositionManager] Target 2 (${multiplier.toFixed(1)}x): ${trade.tokenMint.slice(0, 8)}...`);
      await this.mirrorTrader.executeSell(trade, remaining, 'target2');
      return;
    }

    // Target 1 — sell first portion
    if (trade.status === 'open' && multiplier >= exitStrategy.target1Multiplier) {
      const sellAmount = (exitStrategy.sellPct1 / 100) * trade.entryTokenAmount;
      logger.info(`[PositionManager] Target 1 (${multiplier.toFixed(1)}x): ${trade.tokenMint.slice(0, 8)}... — selling ${exitStrategy.sellPct1}%`);
      await this.mirrorTrader.executeSell(trade, Math.min(sellAmount, remaining), 'target1');
      return;
    }
  }
}
