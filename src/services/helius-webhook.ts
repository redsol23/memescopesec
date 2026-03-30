/**
 * Helius Webhook — Sub-second KOL trade detection.
 *
 * Creates a Helius webhook that monitors all KOL wallet addresses.
 * When a KOL transacts, Helius pushes the parsed transaction to our endpoint.
 * Falls back to polling if Helius is not configured.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { sendTelegramAlert } from '../utils/telegram.js';
import { getCollection } from '../utils/mongodb.js';
import { config } from '../config.js';
import { parsePumpFunTransaction } from './tx-parser.js';
import type { MirrorTrader } from './mirror-trader.js';
import type { KolWalletDoc, KolTrackerStateDoc } from '../types.js';

const HELIUS_API_BASE = 'https://api-mainnet.helius-rpc.com/v0';

export class HeliusWebhookManager {
  private connection: Connection;
  private mirrorTrader: MirrorTrader;
  private webhookId: string | null = null;

  constructor(connection: Connection, mirrorTrader: MirrorTrader) {
    this.connection = connection;
    this.mirrorTrader = mirrorTrader;
  }

  /**
   * Check if Helius webhooks are configured.
   */
  isConfigured(): boolean {
    return !!config.heliusApiKey;
  }

  /**
   * Create or update the Helius webhook with current KOL addresses.
   */
  async setupWebhook(webhookUrl: string): Promise<boolean> {
    if (!config.heliusApiKey) {
      logger.info('[Helius] No API key configured — using polling mode');
      return false;
    }

    const walletsCol = await getCollection<KolWalletDoc>('kol_wallets');
    const kols = await walletsCol.find({ enabled: true }).toArray();
    const addresses = kols.map(k => k.address);

    if (addresses.length === 0) {
      logger.info('[Helius] No KOL wallets to monitor yet');
      return false;
    }

    try {
      if (this.webhookId) {
        // Update existing webhook
        await this.updateWebhook(addresses, webhookUrl);
      } else {
        // Check for existing webhook first
        const existing = await this.findExistingWebhook(webhookUrl);
        if (existing) {
          this.webhookId = existing;
          await this.updateWebhook(addresses, webhookUrl);
        } else {
          await this.createWebhook(addresses, webhookUrl);
        }
      }
      return true;
    } catch (err) {
      logger.error(`[Helius] Webhook setup failed: ${err instanceof Error ? err.message : String(err)}`);
      await sendTelegramAlert(`Helius webhook setup failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Handle incoming webhook event from Helius.
   */
  async handleWebhookEvent(events: any[]): Promise<void> {
    const walletsCol = await getCollection<KolWalletDoc>('kol_wallets');
    const kolMap = new Map<string, KolWalletDoc>();

    // Build lookup map
    const kols = await walletsCol.find({ enabled: true }).toArray();
    for (const kol of kols) kolMap.set(kol.address, kol);

    for (const event of events) {
      try {
        await this.processWebhookEvent(event, kolMap);
      } catch (err) {
        logger.warn(`[Helius] Error processing event: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Process a single webhook event — check if it's a pump.fun buy from a KOL.
   */
  private async processWebhookEvent(event: any, kolMap: Map<string, KolWalletDoc>): Promise<void> {
    const signature = event.signature;
    if (!signature) return;

    // Determine which KOL wallet is involved
    const accountKeys: string[] = event.accountData?.map((a: any) => a.account) ||
      event.transaction?.message?.accountKeys?.map((k: any) => typeof k === 'string' ? k : k.pubkey) || [];

    let matchedKol: KolWalletDoc | undefined;
    for (const key of accountKeys) {
      if (kolMap.has(key)) { matchedKol = kolMap.get(key); break; }
    }

    // Also check nativeTransfers and tokenTransfers for KOL addresses
    if (!matchedKol) {
      const transfers = [...(event.nativeTransfers || []), ...(event.tokenTransfers || [])];
      for (const t of transfers) {
        const addr = t.fromUserAccount || t.toUserAccount;
        if (addr && kolMap.has(addr)) { matchedKol = kolMap.get(addr); break; }
      }
    }

    if (!matchedKol) return;

    // For enhanced webhooks, we may need to fetch the full parsed tx
    // since the webhook payload might not have full token balance info
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) return;

      const parsed = parsePumpFunTransaction(tx, signature, matchedKol.address);
      if (parsed && parsed.direction === 'buy') {
        logger.info(
          `[Helius] KOL BUY (webhook): ${matchedKol.label} bought ` +
          `${parsed.tokenAmount.toFixed(2)} of ${parsed.tokenMint.slice(0, 8)}... ` +
          `for ${parsed.solAmount.toFixed(4)} SOL`
        );
        await this.mirrorTrader.executeMirrorBuy(parsed, matchedKol);
      }
    } catch (err) {
      logger.warn(`[Helius] Failed to process tx ${signature.slice(0, 16)}...: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Refresh webhook when KOL list changes (add/remove/toggle).
   */
  async refreshAddresses(): Promise<void> {
    if (!this.webhookId || !config.heliusApiKey) return;

    const walletsCol = await getCollection<KolWalletDoc>('kol_wallets');
    const kols = await walletsCol.find({ enabled: true }).toArray();
    const addresses = kols.map(k => k.address);

    try {
      const resp = await fetch(`${HELIUS_API_BASE}/webhooks/${this.webhookId}?api-key=${config.heliusApiKey}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountAddresses: addresses }),
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      logger.info(`[Helius] Updated webhook with ${addresses.length} addresses`);
    } catch (err) {
      logger.error(`[Helius] Failed to refresh addresses: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Clean up webhook on shutdown.
   */
  async cleanup(): Promise<void> {
    // Don't delete — we want it to persist across restarts
    logger.info('[Helius] Webhook preserved for restart.');
  }

  // === Private Helpers ===

  private async createWebhook(addresses: string[], webhookUrl: string): Promise<void> {
    const resp = await fetch(`${HELIUS_API_BASE}/webhooks?api-key=${config.heliusApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webhookURL: webhookUrl,
        transactionTypes: ['ANY'],
        accountAddresses: addresses,
        webhookType: 'enhanced',
        authHeader: config.heliusWebhookSecret,
      }),
    });

    if (!resp.ok) throw new Error(`Create webhook failed: ${resp.status} ${await resp.text()}`);

    const data = await resp.json() as { webhookID: string };
    this.webhookId = data.webhookID;
    logger.info(`[Helius] Created webhook ${this.webhookId} monitoring ${addresses.length} addresses`);
  }

  private async updateWebhook(addresses: string[], webhookUrl: string): Promise<void> {
    const resp = await fetch(`${HELIUS_API_BASE}/webhooks/${this.webhookId}?api-key=${config.heliusApiKey}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webhookURL: webhookUrl,
        accountAddresses: addresses,
        transactionTypes: ['ANY'],
      }),
    });

    if (!resp.ok) throw new Error(`Update webhook failed: ${resp.status} ${await resp.text()}`);
    logger.info(`[Helius] Updated webhook ${this.webhookId} with ${addresses.length} addresses`);
  }

  private async findExistingWebhook(webhookUrl: string): Promise<string | null> {
    try {
      const resp = await fetch(`${HELIUS_API_BASE}/webhooks?api-key=${config.heliusApiKey}`);
      if (!resp.ok) return null;

      const webhooks = await resp.json() as any[];
      const existing = webhooks.find((w: any) => w.webhookURL === webhookUrl);
      if (existing) {
        logger.info(`[Helius] Found existing webhook: ${existing.webhookID}`);
        return existing.webhookID;
      }
    } catch {}
    return null;
  }
}
