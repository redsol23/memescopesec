/**
 * Wallet Monitor — Polls KOL wallets for new pump.fun trades.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { getCollection } from '../utils/mongodb.js';
import { config } from '../config.js';
import { parsePumpFunTransaction } from './tx-parser.js';
import type { MirrorTrader } from './mirror-trader.js';
import type { KolWalletDoc, KolTrackerStateDoc } from '../types.js';

export class WalletMonitor {
  private connection: Connection;
  private mirrorTrader: MirrorTrader;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(connection: Connection, mirrorTrader: MirrorTrader) {
    this.connection = connection;
    this.mirrorTrader = mirrorTrader;
  }

  isRunning(): boolean { return this.running; }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info('[WalletMonitor] Starting KOL wallet monitoring...');
    await this.initializeNewKols();
    this.schedulePoll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    logger.info('[WalletMonitor] Stopped.');
  }

  private schedulePoll(): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(async () => {
      try { await this.pollAllKols(); }
      catch (err) { logger.error(`[WalletMonitor] Poll error: ${err instanceof Error ? err.message : String(err)}`); }
      this.schedulePoll();
    }, config.pollIntervalMs);
  }

  private async initializeNewKols(): Promise<void> {
    const walletsCol = await getCollection<KolWalletDoc>('kol_wallets');
    const stateCol = await getCollection<KolTrackerStateDoc>('kol_tracker_state');

    const kols = await walletsCol.find({ enabled: true }).toArray();
    const state = await stateCol.findOne({ _id: 'kol_tracker_state' as any });
    const lastPoll = state?.lastPollPerWallet || {};

    for (const kol of kols) {
      if (lastPoll[kol.address]) continue;
      try {
        const sigs = await this.connection.getSignaturesForAddress(new PublicKey(kol.address), { limit: 1 });
        if (sigs.length > 0) {
          await stateCol.updateOne(
            { _id: 'kol_tracker_state' as any },
            { $set: { [`lastPollPerWallet.${kol.address}`]: sigs[0].signature } },
          );
          logger.info(`[WalletMonitor] Initialized ${kol.label} (${kol.address.slice(0, 8)}...)`);
        }
      } catch (err) {
        logger.warn(`[WalletMonitor] Failed to init ${kol.label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async pollAllKols(): Promise<void> {
    const walletsCol = await getCollection<KolWalletDoc>('kol_wallets');
    const stateCol = await getCollection<KolTrackerStateDoc>('kol_tracker_state');

    const kols = await walletsCol.find({ enabled: true }).toArray();
    if (kols.length === 0) return;

    const state = await stateCol.findOne({ _id: 'kol_tracker_state' as any });
    const lastPoll = state?.lastPollPerWallet || {};

    for (const kol of kols) {
      try { await this.pollKol(kol, lastPoll[kol.address], stateCol); }
      catch (err) { logger.error(`[WalletMonitor] Error polling ${kol.label}: ${err instanceof Error ? err.message : String(err)}`); }
    }
  }

  private async pollKol(
    kol: KolWalletDoc,
    lastSignature: string | undefined,
    stateCol: Awaited<ReturnType<typeof getCollection<KolTrackerStateDoc>>>,
  ): Promise<void> {
    const pubkey = new PublicKey(kol.address);
    const opts: { limit: number; until?: string } = { limit: 10 };
    if (lastSignature) opts.until = lastSignature;

    const sigs = await this.connection.getSignaturesForAddress(pubkey, opts);
    if (sigs.length === 0) return;

    const sorted = [...sigs].reverse();
    let newestSig = lastSignature;

    for (const sigInfo of sorted) {
      if (sigInfo.err) continue;
      try {
        const tx = await this.connection.getParsedTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0 });
        if (!tx) continue;

        const parsed = parsePumpFunTransaction(tx, sigInfo.signature, kol.address);
        if (parsed && parsed.direction === 'buy') {
          logger.info(`[WalletMonitor] KOL BUY: ${kol.label} bought ${parsed.tokenAmount.toFixed(2)} of ${parsed.tokenMint.slice(0, 8)}... for ${parsed.solAmount.toFixed(4)} SOL`);
          await this.mirrorTrader.executeMirrorBuy(parsed, kol);
        }
      } catch (err) {
        logger.warn(`[WalletMonitor] Failed to parse tx ${sigInfo.signature.slice(0, 16)}...: ${err instanceof Error ? err.message : String(err)}`);
      }
      newestSig = sigInfo.signature;
    }

    if (newestSig && newestSig !== lastSignature) {
      await stateCol.updateOne(
        { _id: 'kol_tracker_state' as any },
        { $set: { [`lastPollPerWallet.${kol.address}`]: newestSig } },
      );
    }
  }
}
