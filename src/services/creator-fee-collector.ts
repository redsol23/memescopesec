/**
 * Creator Fee Collector — Auto-claims pump.fun creator fees.
 *
 * Creator fees (0.3-0.95% of every trade) accumulate on-chain in a
 * creator vault PDA. This service periodically claims them to the
 * trading wallet so the agent has SOL to trade with.
 *
 * Flow:
 *   People trade the token → creator fees accumulate in vault
 *     → collectCreatorFee() claims to trading wallet
 *     → Agent uses SOL for copy trades
 */

import {
  Connection, PublicKey, Transaction, Keypair,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import * as PumpSwapSdk from '@pump-fun/pump-swap-sdk';
const {
  OnlinePumpAmmSdk, canonicalPumpPoolPda, coinCreatorVaultAuthorityPda,
  PUMP_AMM_PROGRAM_ID,
} = (PumpSwapSdk as any).default ?? PumpSwapSdk;

import { logger } from '../utils/logger.js';
import { sendTelegramAlert } from '../utils/telegram.js';
import { getCollection } from '../utils/mongodb.js';
import { config } from '../config.js';
import type { KolTrackerStateDoc } from '../types.js';

export class CreatorFeeCollector {
  private connection: Connection;
  private keypair: Keypair;
  private tokenMint: PublicKey | null;
  private collectTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private onlineSdk: any;

  constructor(connection: Connection, keypair: Keypair) {
    this.connection = connection;
    this.keypair = keypair;
    this.tokenMint = config.agentTokenMint ? new PublicKey(config.agentTokenMint) : null;
    this.onlineSdk = new OnlinePumpAmmSdk(connection);
  }

  isConfigured(): boolean {
    return !!config.agentTokenMint;
  }

  start(): void {
    if (this.running || !this.isConfigured()) return;
    this.running = true;

    logger.info(
      `[FeeCollector] Started — claiming every ${config.agentFeeCollectIntervalMs / 1000}s ` +
      `(token: ${config.agentTokenMint.slice(0, 8)}...)`
    );

    this.collect().catch(err =>
      logger.error(`[FeeCollector] Initial collect failed: ${err instanceof Error ? err.message : String(err)}`)
    );

    this.collectTimer = setInterval(async () => {
      try { await this.collect(); }
      catch (err) {
        logger.error(`[FeeCollector] Collect error: ${err instanceof Error ? err.message : String(err)}`);
        await sendTelegramAlert(`Fee collection error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, config.agentFeeCollectIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.collectTimer) { clearInterval(this.collectTimer); this.collectTimer = null; }
    logger.info('[FeeCollector] Stopped.');
  }

  /**
   * Claim accumulated creator fees from the PumpSwap creator vault.
   */
  async collect(): Promise<{ success: boolean; claimed?: number; error?: string }> {
    if (!this.tokenMint) return { success: false, error: 'No token mint configured' };

    try {
      // Check balance before
      const balanceBefore = await this.connection.getBalance(this.keypair.publicKey);

      // Try to claim creator fees via PumpSwap
      const poolKey = canonicalPumpPoolPda(this.tokenMint);

      // Build collect creator fee instruction
      // The creator vault PDA holds accumulated fees
      // Calling collect transfers them to the creator wallet
      const swapState = await this.onlineSdk.swapSolanaState(poolKey, this.keypair.publicKey);

      // Check if there are fees to collect by looking at the creator vault
      const creatorVaultAuth = coinCreatorVaultAuthorityPda(this.tokenMint);
      const vaultBalance = await this.connection.getBalance(creatorVaultAuth);

      if (vaultBalance < 5000) { // Less than dust
        logger.debug('[FeeCollector] No fees to collect');
        return { success: true, claimed: 0 };
      }

      logger.info(`[FeeCollector] Creator vault has ${(vaultBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL — claiming...`);

      // Use the PumpSwap SDK to build collect instruction
      // The SDK exposes this via the online SDK
      const collectIx = await this.onlineSdk.collectCreatorFee
        ? this.onlineSdk.collectCreatorFee(poolKey, this.keypair.publicKey)
        : null;

      if (collectIx) {
        const tx = new Transaction().add(...(Array.isArray(collectIx) ? collectIx : [collectIx]));
        tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
        tx.feePayer = this.keypair.publicKey;
        tx.sign(this.keypair);

        const sig = await this.connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
          maxRetries: 3,
        });

        await this.connection.confirmTransaction(sig, 'confirmed');

        const balanceAfter = await this.connection.getBalance(this.keypair.publicKey);
        const claimed = (balanceAfter - balanceBefore) / LAMPORTS_PER_SOL;

        if (claimed > 0) {
          logger.info(`[FeeCollector] Claimed ${claimed.toFixed(6)} SOL (tx: ${sig.slice(0, 16)}...)`);

          // Update wallet balance in tracker state
          const stateCol = await getCollection<KolTrackerStateDoc>('kol_tracker_state');
          await stateCol.updateOne(
            { _id: 'kol_tracker_state' as any },
            { $set: { walletBalanceSOL: balanceAfter / LAMPORTS_PER_SOL } },
          );
        }

        return { success: true, claimed };
      }

      // Fallback: if SDK doesn't have collectCreatorFee, log for manual claim
      logger.info(`[FeeCollector] ${(vaultBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL in creator vault — claim via pump.fun UI`);
      return { success: true, claimed: 0 };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found') || msg.includes('no pool')) {
        logger.debug(`[FeeCollector] Pool not found yet (token may not have graduated)`);
        return { success: false, error: 'Pool not found' };
      }
      logger.warn(`[FeeCollector] Claim failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  /**
   * Get stats for the dashboard API.
   */
  async getStats(): Promise<{
    configured: boolean;
    tokenMint: string;
    creatorVaultSOL?: number;
  }> {
    const stats: any = {
      configured: this.isConfigured(),
      tokenMint: config.agentTokenMint,
    };

    if (this.isConfigured() && this.tokenMint) {
      try {
        const creatorVaultAuth = coinCreatorVaultAuthorityPda(this.tokenMint);
        const balance = await this.connection.getBalance(creatorVaultAuth);
        stats.creatorVaultSOL = balance / LAMPORTS_PER_SOL;
      } catch {}
    }

    return stats;
  }
}
