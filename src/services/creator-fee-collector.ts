/**
 * Creator Fee Collector — Collects pump.fun tokenized agent revenue.
 *
 * Periodically calls distributePayments() to split accumulated creator fees
 * into buyback vault (auto buy+burn) and withdraw vault, then withdraw()
 * to fund the trading wallet.
 *
 * Flow:
 *   Creator fees accumulate in payment vault
 *     → distributePayments() splits by buybackBps (50/50)
 *       → 50% → buyback vault (pump.fun handles buy+burn automatically)
 *       → 50% → withdraw vault
 *     → withdraw() moves funds from withdraw vault → trading wallet ATA
 */

import {
  Connection, PublicKey, Transaction, Keypair,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import { logger } from '../utils/logger.js';
import { sendTelegramAlert } from '../utils/telegram.js';
import { getCollection } from '../utils/mongodb.js';
import { config } from '../config.js';
import type { KolTrackerStateDoc } from '../types.js';

// Dynamic import to handle ESM/CJS compat
let PumpAgent: any;
let PumpAgentOffline: any;

async function loadSdk() {
  if (PumpAgent) return;
  const sdk = await import('@pump-fun/agent-payments-sdk');
  const mod = (sdk as any).default ?? sdk;
  PumpAgent = mod.PumpAgent ?? mod.default?.PumpAgent;
  PumpAgentOffline = mod.PumpAgentOffline ?? mod.default?.PumpAgentOffline;

  // Fallback: try named exports directly
  if (!PumpAgent && !PumpAgentOffline) {
    PumpAgent = sdk.PumpAgent;
    PumpAgentOffline = sdk.PumpAgentOffline;
  }
}

export interface FeeCollectionResult {
  distributed: boolean;
  withdrawn: boolean;
  withdrawnAmount?: number;
  buybackAmount?: number;
  error?: string;
}

export class CreatorFeeCollector {
  private connection: Connection;
  private keypair: Keypair;
  private tokenMint: PublicKey;
  private currencyMint: PublicKey;
  private collectTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(connection: Connection, keypair: Keypair) {
    this.connection = connection;
    this.keypair = keypair;
    this.tokenMint = new PublicKey(config.agentTokenMint);
    this.currencyMint = new PublicKey(config.agentCurrencyMint);
  }

  isConfigured(): boolean {
    return !!config.agentTokenMint;
  }

  start(): void {
    if (this.running || !this.isConfigured()) return;
    this.running = true;

    logger.info(
      `[FeeCollector] Started — collecting every ${config.agentFeeCollectIntervalMs / 1000}s ` +
      `(mint: ${config.agentTokenMint.slice(0, 8)}..., buyback: ${config.agentBuybackBps / 100}%)`
    );

    // Run immediately on start, then on interval
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
   * Run one collection cycle: distribute + withdraw.
   */
  async collect(): Promise<FeeCollectionResult> {
    await loadSdk();

    const result: FeeCollectionResult = { distributed: false, withdrawn: false };

    try {
      // 1. Check balances first
      const balances = await this.getBalances();
      if (!balances) {
        logger.debug('[FeeCollector] No agent balances available yet');
        return result;
      }

      logger.info(
        `[FeeCollector] Balances — payment: ${balances.paymentVault}, ` +
        `buyback: ${balances.buybackVault}, withdraw: ${balances.withdrawVault}`
      );

      // 2. Distribute if there are funds in the payment vault
      if (balances.paymentVaultRaw > 0) {
        const distResult = await this.distribute();
        result.distributed = distResult;
        if (distResult) {
          logger.info('[FeeCollector] Distribution complete');
        }
      }

      // 3. Withdraw if there are funds in the withdraw vault
      const postBalances = await this.getBalances();
      if (postBalances && postBalances.withdrawVaultRaw > 0) {
        const withdrawResult = await this.withdraw();
        result.withdrawn = withdrawResult.success;
        result.withdrawnAmount = withdrawResult.amount;

        if (withdrawResult.success && withdrawResult.amount > 0) {
          logger.info(`[FeeCollector] Withdrew ${withdrawResult.amount.toFixed(6)} to trading wallet`);

          // Update wallet balance in tracker state
          const balance = await this.connection.getBalance(this.keypair.publicKey);
          const stateCol = await getCollection<KolTrackerStateDoc>('kol_tracker_state');
          await stateCol.updateOne(
            { _id: 'kol_tracker_state' as any },
            { $set: { walletBalanceSOL: balance / LAMPORTS_PER_SOL } },
          );
        }
      }

    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      logger.error(`[FeeCollector] Collection failed: ${result.error}`);
    }

    return result;
  }

  /**
   * Get current balances across all vaults.
   */
  private async getBalances(): Promise<{
    paymentVault: string;
    buybackVault: string;
    withdrawVault: string;
    paymentVaultRaw: number;
    buybackVaultRaw: number;
    withdrawVaultRaw: number;
  } | null> {
    try {
      if (PumpAgent) {
        const agent = new PumpAgent(this.tokenMint, undefined, this.connection);
        const balances = await agent.getBalances(this.currencyMint);
        return {
          paymentVault: formatBalance(balances.paymentVault),
          buybackVault: formatBalance(balances.buybackVault),
          withdrawVault: formatBalance(balances.withdrawVault),
          paymentVaultRaw: balances.paymentVault?.amount ?? 0,
          buybackVaultRaw: balances.buybackVault?.amount ?? 0,
          withdrawVaultRaw: balances.withdrawVault?.amount ?? 0,
        };
      }
      return null;
    } catch (err) {
      logger.debug(`[FeeCollector] getBalances error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Call distributePayments() — permissionless, splits payment vault
   * into buyback vault + withdraw vault based on buybackBps.
   */
  private async distribute(): Promise<boolean> {
    try {
      const AgentClass = PumpAgentOffline || PumpAgent;
      const agent = PumpAgentOffline
        ? PumpAgentOffline.load(this.tokenMint, this.connection)
        : new PumpAgent(this.tokenMint, undefined, this.connection);

      const instructions = await agent.distributePayments({
        user: this.keypair.publicKey,
        currencyMint: this.currencyMint,
      });

      if (!instructions || instructions.length === 0) {
        logger.debug('[FeeCollector] No distribute instructions returned');
        return false;
      }

      const tx = new Transaction().add(...instructions);
      tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
      tx.feePayer = this.keypair.publicKey;

      const sig = await sendAndConfirmTransaction(
        this.connection, tx, [this.keypair], { commitment: 'confirmed' },
      );

      logger.info(`[FeeCollector] distributePayments tx: ${sig.slice(0, 16)}...`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "already distributed" or "nothing to distribute" are not errors
      if (msg.includes('0x0') || msg.includes('insufficient') || msg.includes('no funds')) {
        logger.debug(`[FeeCollector] Nothing to distribute: ${msg}`);
        return false;
      }
      logger.warn(`[FeeCollector] distribute failed: ${msg}`);
      return false;
    }
  }

  /**
   * Call withdraw() — moves funds from withdraw vault to our trading wallet ATA.
   */
  private async withdraw(): Promise<{ success: boolean; amount: number }> {
    try {
      const AgentClass = PumpAgentOffline || PumpAgent;
      const agent = PumpAgentOffline
        ? PumpAgentOffline.load(this.tokenMint, this.connection)
        : new PumpAgent(this.tokenMint, undefined, this.connection);

      // Get or create our ATA for the currency
      const receiverAta = await getAssociatedTokenAddress(
        this.currencyMint, this.keypair.publicKey,
      );

      // Ensure ATA exists
      const ataIx = createAssociatedTokenAccountIdempotentInstruction(
        this.keypair.publicKey, receiverAta, this.keypair.publicKey, this.currencyMint,
      );

      const withdrawIx = await agent.withdraw({
        authority: this.keypair.publicKey,
        currencyMint: this.currencyMint,
        receiverAta,
      });

      const tx = new Transaction().add(ataIx, withdrawIx);
      tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
      tx.feePayer = this.keypair.publicKey;

      const sig = await sendAndConfirmTransaction(
        this.connection, tx, [this.keypair], { commitment: 'confirmed' },
      );

      // Check how much we received
      const postBalance = await this.connection.getTokenAccountBalance(receiverAta);
      const amount = postBalance.value.uiAmount ?? 0;

      logger.info(`[FeeCollector] withdraw tx: ${sig.slice(0, 16)}... (${amount} received)`);
      return { success: true, amount };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('0x0') || msg.includes('insufficient') || msg.includes('no funds')) {
        logger.debug(`[FeeCollector] Nothing to withdraw: ${msg}`);
        return { success: false, amount: 0 };
      }
      logger.warn(`[FeeCollector] withdraw failed: ${msg}`);
      return { success: false, amount: 0 };
    }
  }

  /**
   * Get stats for the dashboard API.
   */
  async getStats(): Promise<{
    configured: boolean;
    tokenMint: string;
    buybackBps: number;
    paymentVault?: string;
    buybackVault?: string;
    withdrawVault?: string;
  }> {
    const stats: any = {
      configured: this.isConfigured(),
      tokenMint: config.agentTokenMint,
      buybackBps: config.agentBuybackBps,
    };

    if (this.isConfigured()) {
      const balances = await this.getBalances();
      if (balances) {
        stats.paymentVault = balances.paymentVault;
        stats.buybackVault = balances.buybackVault;
        stats.withdrawVault = balances.withdrawVault;
      }
    }

    return stats;
  }
}

function formatBalance(vault: any): string {
  if (!vault) return '0';
  const amount = vault.amount ?? vault.uiAmount ?? 0;
  return typeof amount === 'number' ? amount.toFixed(6) : String(amount);
}
