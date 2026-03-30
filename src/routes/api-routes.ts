/**
 * API Routes for the KOL tracker dashboard.
 */

import type { Express, Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { getCollection } from '../utils/mongodb.js';
import { config } from '../config.js';
import { refreshKolsFromKolscan } from '../services/kolscan-scraper.js';
import type { WalletMonitor } from '../services/wallet-monitor.js';
import type { MirrorTrader } from '../services/mirror-trader.js';
import type { PositionManager } from '../services/position-manager.js';
import type { PnlTracker } from '../services/pnl-tracker.js';
import type { KolWalletDoc, KolTradeDoc } from '../types.js';

export function setupApiRoutes(
  app: Express,
  walletMonitor: WalletMonitor,
  mirrorTrader: MirrorTrader,
  positionManager: PositionManager,
  pnlTracker: PnlTracker,
): void {

  // === KOL Management ===

  app.get('/api/kols', async (_req, res) => {
    try {
      const col = await getCollection<KolWalletDoc>('kol_wallets');
      res.json(await col.find().sort({ 'stats.totalPnlSOL': -1 }).toArray());
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  app.post('/api/kols', async (req, res) => {
    try {
      const { address, label } = req.body;
      if (!address || !label) { res.status(400).json({ error: 'address and label required' }); return; }
      const col = await getCollection<KolWalletDoc>('kol_wallets');
      if (await col.findOne({ address })) { res.status(409).json({ error: 'KOL already exists' }); return; }
      await col.insertOne({
        address, label, enabled: true, addedAt: new Date(), source: 'manual',
        exitStrategy: { ...config.defaultExitStrategy },
        stats: { totalTrades: 0, wins: 0, losses: 0, totalPnlSOL: 0, avgReturnPct: 0, lastTradeAt: null },
      });
      res.json({ success: true, message: `Added ${label}` });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  app.put('/api/kols/:address', async (req, res) => {
    try {
      const updates: Record<string, any> = {};
      if (req.body.label) updates.label = req.body.label;
      if (typeof req.body.enabled === 'boolean') updates.enabled = req.body.enabled;
      if (req.body.exitStrategy) updates.exitStrategy = req.body.exitStrategy;
      const col = await getCollection<KolWalletDoc>('kol_wallets');
      await col.updateOne({ address: req.params.address }, { $set: updates });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  app.delete('/api/kols/:address', async (req, res) => {
    try {
      const col = await getCollection<KolWalletDoc>('kol_wallets');
      await col.updateOne({ address: req.params.address }, { $set: { enabled: false } });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // === Trades ===

  app.get('/api/trades', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const skip = parseInt(req.query.skip as string) || 0;
      const col = await getCollection<KolTradeDoc>('kol_trades');
      const trades = await col.find().sort({ entryAt: -1 }).skip(skip).limit(limit).toArray();
      res.json({ trades, total: await col.countDocuments(), limit, skip });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  app.get('/api/trades/open', async (_req, res) => {
    try {
      const col = await getCollection<KolTradeDoc>('kol_trades');
      res.json(await col.find({ status: { $in: ['open', 'partial_exit'] } }).sort({ entryAt: -1 }).toArray());
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  app.post('/api/trades/:id/sell', async (req, res) => {
    try {
      const col = await getCollection<KolTradeDoc>('kol_trades');
      const trade = await col.findOne({ _id: new ObjectId(req.params.id) });
      if (!trade) { res.status(404).json({ error: 'Trade not found' }); return; }
      if (trade.status === 'closed' || trade.status === 'failed') { res.status(400).json({ error: `Trade is ${trade.status}` }); return; }
      const totalSold = trade.exits.reduce((sum, e) => sum + e.tokensSold, 0);
      const remaining = trade.entryTokenAmount - totalSold;
      if (remaining <= 0) { res.status(400).json({ error: 'No tokens remaining' }); return; }
      res.json(await mirrorTrader.executeSell(trade, remaining, 'manual'));
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // === Stats ===

  app.get('/api/stats', async (_req, res) => {
    try { res.json(await pnlTracker.getOverallStats()); }
    catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // === Kolscan ===

  app.get('/api/kolscan/refresh', async (_req, res) => {
    try { res.json(await refreshKolsFromKolscan()); }
    catch (err) { res.status(500).json({ error: String(err) }); }
  });
}
