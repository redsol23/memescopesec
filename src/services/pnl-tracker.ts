/**
 * PnL Tracker — Aggregates PnL per KOL and overall portfolio.
 */

import { logger } from '../utils/logger.js';
import { getCollection } from '../utils/mongodb.js';
import type { KolTradeDoc, KolWalletDoc, KolTrackerStateDoc, OverallStats } from '../types.js';
import { getPositionSizeForTier } from '../config.js';

const JUPITER_PRICE_API = 'https://api.jup.ag/price/v2';

export class PnlTracker {
  async getTokenPriceSOL(tokenMint: string): Promise<number | null> {
    try {
      const resp = await fetch(`${JUPITER_PRICE_API}?ids=${tokenMint}&vsToken=So11111111111111111111111111111111111111112`);
      if (!resp.ok) return null;
      const data = await resp.json() as any;
      const price = data?.data?.[tokenMint]?.price;
      return price ? parseFloat(price) : null;
    } catch { return null; }
  }

  async updateAllOpenPositions(): Promise<void> {
    const tradesCol = await getCollection<KolTradeDoc>('kol_trades');
    const openTrades = await tradesCol.find({ status: { $in: ['open', 'partial_exit'] } }).toArray();
    if (openTrades.length === 0) return;

    const mints = [...new Set(openTrades.map(t => t.tokenMint))];
    const prices: Record<string, number> = {};
    for (const mint of mints) {
      const price = await this.getTokenPriceSOL(mint);
      if (price !== null) prices[mint] = price;
    }

    for (const trade of openTrades) {
      const currentPrice = prices[trade.tokenMint];
      if (currentPrice === undefined) continue;

      const totalSold = trade.exits.reduce((sum, e) => sum + e.tokensSold, 0);
      const remaining = trade.entryTokenAmount - totalSold;
      if (remaining <= 0) continue;

      const currentValue = remaining * currentPrice;
      const costBasis = (remaining / trade.entryTokenAmount) * trade.entryAmountSOL;
      const unrealizedPnl = currentValue - costBasis;
      const totalRealizedSol = trade.exits.reduce((sum, e) => sum + e.solReceived, 0);
      const totalReturn = ((totalRealizedSol + currentValue) / trade.entryAmountSOL - 1) * 100;

      await tradesCol.updateOne(
        { _id: trade._id },
        { $set: { currentPricePerToken: currentPrice, unrealizedPnlSOL: unrealizedPnl, lastPriceUpdate: new Date(), returnPct: totalReturn } },
      );
    }
  }

  async updateKolStats(kolAddress: string): Promise<void> {
    const tradesCol = await getCollection<KolTradeDoc>('kol_trades');
    const walletsCol = await getCollection<KolWalletDoc>('kol_wallets');

    const trades = await tradesCol.find({ kolAddress, status: { $in: ['closed', 'partial_exit'] } }).toArray();
    if (trades.length === 0) return;

    const wins = trades.filter(t => t.realizedPnlSOL > 0).length;
    const totalPnl = trades.reduce((sum, t) => sum + t.realizedPnlSOL, 0);
    const avgReturn = trades.reduce((sum, t) => sum + t.returnPct, 0) / trades.length;
    const lastTrade = trades.sort((a, b) => new Date(b.entryAt).getTime() - new Date(a.entryAt).getTime())[0];

    await walletsCol.updateOne({ address: kolAddress }, {
      $set: {
        'stats.totalTrades': trades.length, 'stats.wins': wins,
        'stats.losses': trades.length - wins, 'stats.totalPnlSOL': totalPnl,
        'stats.avgReturnPct': avgReturn, 'stats.lastTradeAt': lastTrade?.entryAt || null,
      },
    });
  }

  async getOverallStats(): Promise<OverallStats> {
    const walletsCol = await getCollection<KolWalletDoc>('kol_wallets');
    const tradesCol = await getCollection<KolTradeDoc>('kol_trades');
    const stateCol = await getCollection<KolTrackerStateDoc>('kol_tracker_state');

    const [totalKols, enabledKols, state] = await Promise.all([
      walletsCol.countDocuments(), walletsCol.countDocuments({ enabled: true }),
      stateCol.findOne({ _id: 'kol_tracker_state' as any }),
    ]);
    const [totalTrades, openPositions] = await Promise.all([
      tradesCol.countDocuments({ status: { $ne: 'failed' } }),
      tradesCol.countDocuments({ status: { $in: ['open', 'partial_exit'] } }),
    ]);

    const closedTrades = await tradesCol.find({ status: 'closed' }).toArray();
    const totalRealizedPnl = closedTrades.reduce((sum, t) => sum + t.realizedPnlSOL, 0);
    const wins = closedTrades.filter(t => t.realizedPnlSOL > 0).length;
    const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0;

    const openTrades = await tradesCol.find({ status: { $in: ['open', 'partial_exit'] } }).toArray();
    const totalUnrealizedPnl = openTrades.reduce((sum, t) => sum + t.unrealizedPnlSOL, 0);
    const currentTier = state?.currentTier ?? 0;

    return {
      totalKols, enabledKols, totalTrades, openPositions,
      totalRealizedPnlSOL: totalRealizedPnl, totalUnrealizedPnlSOL: totalUnrealizedPnl,
      winRate, currentTier, currentPositionSizeSOL: getPositionSizeForTier(currentTier),
      walletBalanceSOL: state?.walletBalanceSOL ?? 0,
    };
  }
}
