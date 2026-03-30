/**
 * Mirror Trader — Executes copy trades via PumpSwap + Jupiter fallback.
 */

import {
  Connection, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL, SystemProgram, Keypair, VersionedTransaction,
} from '@solana/web3.js';
import {
  getAccount, getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction, createSyncNativeInstruction, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import BN from 'bn.js';
import * as PumpSwapSdk from '@pump-fun/pump-swap-sdk';
const {
  PumpAmmSdk, OnlinePumpAmmSdk, canonicalPumpPoolPda,
  buyQuoteInput, sellBaseInput: sdkSellBaseInput,
  GLOBAL_VOLUME_ACCUMULATOR_PDA, PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, userVolumeAccumulatorPda,
} = (PumpSwapSdk as any).default ?? PumpSwapSdk;

import { logger } from '../utils/logger.js';
import { getCollection } from '../utils/mongodb.js';
import { config, getPositionSizeForTier, calculateTier } from '../config.js';
import type { ParsedPumpTrade, KolWalletDoc, KolTradeDoc, KolTrackerStateDoc } from '../types.js';
import type { PnlTracker } from './pnl-tracker.js';

const PUMPFUN_FRONTEND_ACCOUNT = new PublicKey('DhobWTy4RX64VBwcML9e53gpXqbWDG3NoveR5Mn58seh');
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

export class MirrorTrader {
  private connection: Connection;
  private keypair: Keypair;
  private pnlTracker: PnlTracker;
  private pumpAmmSdk: any;
  private onlineSdk: any;

  constructor(connection: Connection, keypair: Keypair, pnlTracker: PnlTracker) {
    this.connection = connection;
    this.keypair = keypair;
    this.pnlTracker = pnlTracker;
    this.pumpAmmSdk = new PumpAmmSdk(connection);
    this.onlineSdk = new OnlinePumpAmmSdk(connection);
  }

  async executeMirrorBuy(trade: ParsedPumpTrade, kol: KolWalletDoc): Promise<void> {
    const tradesCol = await getCollection<KolTradeDoc>('kol_trades');

    // Dedup
    const existing = await tradesCol.findOne({ kolTxSignature: trade.signature });
    if (existing) { logger.debug(`[MirrorTrader] Already mirrored ${trade.signature.slice(0, 16)}...`); return; }

    // Skip if already have open position on this token from this KOL
    const openPosition = await tradesCol.findOne({
      kolAddress: kol.address, tokenMint: trade.tokenMint,
      status: { $in: ['open', 'partial_exit'] },
    });
    if (openPosition) { logger.info(`[MirrorTrader] Already tracking ${trade.tokenMint.slice(0, 8)}... from ${kol.label}`); return; }

    // Get tier + position size
    const stateCol = await getCollection<KolTrackerStateDoc>('kol_tracker_state');
    const state = await stateCol.findOne({ _id: 'kol_tracker_state' as any });
    const currentTier = state?.currentTier ?? 0;
    const positionSize = getPositionSizeForTier(currentTier);

    // Balance check
    const balance = await this.connection.getBalance(this.keypair.publicKey);
    const balanceSOL = balance / LAMPORTS_PER_SOL;
    if (balanceSOL < positionSize + 0.005) {
      logger.warn(`[MirrorTrader] Insufficient balance (${balanceSOL.toFixed(4)} SOL) for ${positionSize} SOL position`);
      return;
    }

    logger.info(`[MirrorTrader] Mirroring ${kol.label}: ${positionSize} SOL -> ${trade.tokenMint.slice(0, 8)}... (tier ${currentTier})`);

    // Execute buy — PumpSwap first, Jupiter fallback
    let result: { success: boolean; signature?: string; amountOut?: number; error?: string };
    try {
      result = await this.buyViaPumpSwap(trade.tokenMint, positionSize);
    } catch (err) {
      logger.warn(`[MirrorTrader] PumpSwap failed, trying Jupiter: ${err instanceof Error ? err.message : String(err)}`);
      result = await this.buyViaJupiter(trade.tokenMint, positionSize);
    }

    if (!result.success) {
      logger.error(`[MirrorTrader] Mirror buy failed: ${result.error}`);
      await tradesCol.insertOne({
        kolAddress: kol.address, kolLabel: kol.label, tokenMint: trade.tokenMint,
        status: 'failed', entrySignature: trade.signature, mirrorSignature: '',
        entryAmountSOL: positionSize, entryTokenAmount: 0, entryPricePerToken: 0,
        entryAt: new Date(), exits: [], realizedPnlSOL: 0, unrealizedPnlSOL: 0,
        currentPricePerToken: 0, lastPriceUpdate: new Date(), returnPct: 0,
        kolTxSignature: trade.signature,
      });
      return;
    }

    const tokenAmount = result.amountOut || 0;
    const pricePerToken = tokenAmount > 0 ? positionSize / tokenAmount : 0;

    await tradesCol.insertOne({
      kolAddress: kol.address, kolLabel: kol.label, tokenMint: trade.tokenMint,
      status: 'open', entrySignature: trade.signature, mirrorSignature: result.signature || '',
      entryAmountSOL: positionSize, entryTokenAmount: tokenAmount, entryPricePerToken: pricePerToken,
      entryAt: new Date(), exits: [], realizedPnlSOL: 0, unrealizedPnlSOL: 0,
      currentPricePerToken: pricePerToken, lastPriceUpdate: new Date(), returnPct: 0,
      kolTxSignature: trade.signature,
    });

    const newBalance = await this.connection.getBalance(this.keypair.publicKey);
    await stateCol.updateOne(
      { _id: 'kol_tracker_state' as any },
      { $set: { walletBalanceSOL: newBalance / LAMPORTS_PER_SOL } },
    );

    logger.info(`[MirrorTrader] SUCCESS: ${positionSize} SOL -> ${tokenAmount.toFixed(2)} tokens (${trade.tokenMint.slice(0, 8)}...) tx: ${result.signature?.slice(0, 16)}...`);
  }

  async executeSell(
    trade: KolTradeDoc, tokenAmount: number,
    reason: 'target1' | 'target2' | 'time_limit' | 'manual',
  ): Promise<{ success: boolean; solReceived?: number; signature?: string }> {
    logger.info(`[MirrorTrader] Selling ${tokenAmount.toFixed(2)} of ${trade.tokenMint.slice(0, 8)}... (${reason})`);

    let result: { success: boolean; signature?: string; amountOut?: number; error?: string };
    try {
      result = await this.sellViaPumpSwap(trade.tokenMint, tokenAmount);
    } catch (err) {
      logger.warn(`[MirrorTrader] PumpSwap sell failed, trying Jupiter: ${err instanceof Error ? err.message : String(err)}`);
      result = await this.sellViaJupiter(trade.tokenMint, tokenAmount);
    }

    if (!result.success) { logger.error(`[MirrorTrader] Sell failed: ${result.error}`); return { success: false }; }

    const solReceived = result.amountOut || 0;
    const tradesCol = await getCollection<KolTradeDoc>('kol_trades');
    const exit = { signature: result.signature || '', tokensSold: tokenAmount, solReceived, exitAt: new Date(), reason };

    const allExits = [...(trade.exits || []), exit];
    const totalSold = allExits.reduce((sum, e) => sum + e.tokensSold, 0);
    const remaining = trade.entryTokenAmount - totalSold;
    const newStatus = remaining <= 0.01 ? 'closed' : 'partial_exit';

    const totalSolReceived = allExits.reduce((sum, e) => sum + e.solReceived, 0);
    const proportionSold = totalSold / trade.entryTokenAmount;
    const costBasis = trade.entryAmountSOL * proportionSold;
    const realizedPnl = totalSolReceived - costBasis;

    await tradesCol.updateOne(
      { _id: trade._id },
      { $push: { exits: exit as any }, $set: { status: newStatus, realizedPnlSOL: realizedPnl, returnPct: costBasis > 0 ? ((totalSolReceived / costBasis) - 1) * 100 : 0 } },
    );

    if (newStatus === 'closed') {
      await this.pnlTracker.updateKolStats(trade.kolAddress);
      await this.updateTrackerPnl(realizedPnl);
    }

    logger.info(`[MirrorTrader] Sell OK: ${tokenAmount.toFixed(2)} tokens -> ${solReceived.toFixed(4)} SOL (PnL: ${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(4)})`);
    return { success: true, solReceived, signature: result.signature };
  }

  // === PumpSwap Buy/Sell ===

  private async buyViaPumpSwap(tokenMint: string, amountSOL: number) {
    const slippagePercent = config.maxSlippageBps / 100;
    const quoteLamports = new BN(Math.floor(amountSOL * LAMPORTS_PER_SOL));

    const poolKey = canonicalPumpPoolPda(new PublicKey(tokenMint));
    const swapState = await this.onlineSdk.swapSolanaState(poolKey, this.keypair.publicKey);

    const buyCalc = buyQuoteInput({
      quote: quoteLamports, slippage: slippagePercent,
      baseReserve: swapState.poolBaseAmount, quoteReserve: swapState.poolQuoteAmount,
      globalConfig: swapState.globalConfig, baseMintAccount: swapState.baseMintAccount,
      baseMint: swapState.baseMint, coinCreator: swapState.pool.coinCreator,
      creator: swapState.pool.creator, feeConfig: swapState.feeConfig,
    });

    const sa = (this.pumpAmmSdk as any).swapAccounts(swapState);
    const instructions = this.buildBuyInstructions(sa, swapState, buyCalc.base, buyCalc.maxQuote);

    const tx = new Transaction().add(...instructions);
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
    tx.feePayer = this.keypair.publicKey;

    const signature = await sendAndConfirmTransaction(this.connection, tx, [this.keypair], { commitment: 'confirmed' });
    return { success: true, signature, amountOut: buyCalc.base.toNumber() };
  }

  private async sellViaPumpSwap(tokenMint: string, tokenAmount: number) {
    const slippagePercent = config.maxSlippageBps / 100;
    const poolKey = canonicalPumpPoolPda(new PublicKey(tokenMint));
    const swapState = await this.onlineSdk.swapSolanaState(poolKey, this.keypair.publicKey);

    const decimals = swapState.baseMintAccount.decimals;
    const baseAmount = new BN(Math.floor(tokenAmount * Math.pow(10, decimals)));

    const sellCalc = sdkSellBaseInput({
      base: baseAmount, slippage: slippagePercent,
      baseReserve: swapState.poolBaseAmount, quoteReserve: swapState.poolQuoteAmount,
      globalConfig: swapState.globalConfig, baseMintAccount: swapState.baseMintAccount,
      baseMint: swapState.baseMint, coinCreator: swapState.pool.coinCreator,
      creator: swapState.pool.creator, feeConfig: swapState.feeConfig,
    });

    const sa = (this.pumpAmmSdk as any).swapAccounts(swapState);
    const instructions = this.buildSellInstructions(sa, swapState, baseAmount, sellCalc.minQuote);

    const tx = new Transaction().add(...instructions);
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
    tx.feePayer = this.keypair.publicKey;

    const signature = await sendAndConfirmTransaction(this.connection, tx, [this.keypair], { commitment: 'confirmed' });
    return { success: true, signature, amountOut: sellCalc.uiQuote.toNumber() / LAMPORTS_PER_SOL };
  }

  // === Jupiter Fallback ===

  private async buyViaJupiter(tokenMint: string, amountSOL: number) {
    try {
      const quote = await this.jupiterQuote(SOL_MINT, tokenMint, Math.floor(amountSOL * LAMPORTS_PER_SOL));
      const signature = await this.jupiterSwap(quote);
      const amountOut = quote.outAmount ? parseFloat(quote.outAmount) / Math.pow(10, quote.outDecimals ?? 6) : 0;
      return { success: true, signature, amountOut };
    } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; }
  }

  private async sellViaJupiter(tokenMint: string, tokenAmount: number) {
    try {
      const amountRaw = Math.floor(tokenAmount * 1e6);
      const quote = await this.jupiterQuote(tokenMint, SOL_MINT, amountRaw);
      const signature = await this.jupiterSwap(quote);
      const amountOut = quote.outAmount ? parseFloat(quote.outAmount) / LAMPORTS_PER_SOL : 0;
      return { success: true, signature, amountOut };
    } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; }
  }

  private async jupiterQuote(inputMint: string, outputMint: string, amount: number): Promise<any> {
    const params = new URLSearchParams({ inputMint, outputMint, amount: amount.toString(), slippageBps: config.maxSlippageBps.toString() });
    const resp = await fetch(`${JUPITER_QUOTE_API}/quote?${params}`);
    if (!resp.ok) throw new Error(`Jupiter quote failed: ${resp.status}`);
    return resp.json();
  }

  private async jupiterSwap(quote: any): Promise<string> {
    const resp = await fetch(`${JUPITER_QUOTE_API}/swap`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: this.keypair.publicKey.toBase58(), wrapAndUnwrapSol: true }),
    });
    if (!resp.ok) throw new Error(`Jupiter swap failed: ${resp.status}`);
    const { swapTransaction } = await resp.json() as { swapTransaction: string };
    const txBuf = Buffer.from(swapTransaction, 'base64');
    const vtx = VersionedTransaction.deserialize(txBuf);
    vtx.sign([this.keypair]);
    const signature = await this.connection.sendTransaction(vtx);
    await this.connection.confirmTransaction(signature, 'confirmed');
    return signature;
  }

  // === Instruction Builders ===

  private buildSwapKeys(sa: any, user: PublicKey) {
    return [
      { pubkey: sa.pool, isWritable: true, isSigner: false },
      { pubkey: user, isWritable: true, isSigner: true },
      { pubkey: sa.globalConfig, isWritable: false, isSigner: false },
      { pubkey: sa.baseMint, isWritable: false, isSigner: false },
      { pubkey: sa.quoteMint, isWritable: false, isSigner: false },
      { pubkey: sa.userBaseTokenAccount, isWritable: true, isSigner: false },
      { pubkey: sa.userQuoteTokenAccount, isWritable: true, isSigner: false },
      { pubkey: sa.poolBaseTokenAccount, isWritable: true, isSigner: false },
      { pubkey: sa.poolQuoteTokenAccount, isWritable: true, isSigner: false },
      { pubkey: sa.protocolFeeRecipient, isWritable: false, isSigner: false },
      { pubkey: sa.protocolFeeRecipientTokenAccount, isWritable: true, isSigner: false },
      { pubkey: sa.baseTokenProgram, isWritable: false, isSigner: false },
      { pubkey: sa.quoteTokenProgram, isWritable: false, isSigner: false },
      { pubkey: sa.systemProgram, isWritable: false, isSigner: false },
      { pubkey: sa.associatedTokenProgram, isWritable: false, isSigner: false },
      { pubkey: sa.eventAuthority, isWritable: false, isSigner: false },
      { pubkey: sa.program, isWritable: false, isSigner: false },
      { pubkey: sa.coinCreatorVaultAta, isWritable: true, isSigner: false },
      { pubkey: sa.coinCreatorVaultAuthority, isWritable: false, isSigner: false },
      { pubkey: GLOBAL_VOLUME_ACCUMULATOR_PDA, isWritable: false, isSigner: false },
      { pubkey: userVolumeAccumulatorPda(user), isWritable: true, isSigner: false },
      { pubkey: PUMP_AMM_FEE_CONFIG_PDA, isWritable: false, isSigner: false },
      { pubkey: PUMP_FEE_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: PUMPFUN_FRONTEND_ACCOUNT, isWritable: false, isSigner: false },
    ];
  }

  private buildBuyInstructions(sa: any, swapState: any, baseAmountOut: BN, maxQuoteAmountIn: BN): TransactionInstruction[] {
    const instructions: TransactionInstruction[] = [];
    const user = sa.user as PublicKey;

    if (!swapState.userBaseAccountInfo) instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, sa.userBaseTokenAccount, user, sa.baseMint, sa.baseTokenProgram));
    if (!swapState.userQuoteAccountInfo) instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, sa.userQuoteTokenAccount, user, sa.quoteMint, sa.quoteTokenProgram));

    instructions.push(
      SystemProgram.transfer({ fromPubkey: user, toPubkey: sa.userQuoteTokenAccount, lamports: maxQuoteAmountIn.toNumber() }),
      createSyncNativeInstruction(sa.userQuoteTokenAccount),
    );

    const data = Buffer.alloc(25);
    BUY_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(BigInt(baseAmountOut.toString()), 8);
    data.writeBigUInt64LE(BigInt(maxQuoteAmountIn.toString()), 16);
    data.writeUInt8(1, 24);

    instructions.push(new TransactionInstruction({ programId: PUMP_AMM_PROGRAM_ID, keys: this.buildSwapKeys(sa, user), data }));
    instructions.push(createCloseAccountInstruction(sa.userQuoteTokenAccount, user, user, undefined, TOKEN_PROGRAM_ID));
    return instructions;
  }

  private buildSellInstructions(sa: any, swapState: any, baseAmountIn: BN, minQuoteOut: BN): TransactionInstruction[] {
    const instructions: TransactionInstruction[] = [];
    const user = sa.user as PublicKey;

    if (!swapState.userQuoteAccountInfo) instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, sa.userQuoteTokenAccount, user, sa.quoteMint, sa.quoteTokenProgram));

    const data = Buffer.alloc(25);
    SELL_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(BigInt(baseAmountIn.toString()), 8);
    data.writeBigUInt64LE(BigInt(minQuoteOut.toString()), 16);
    data.writeUInt8(1, 24);

    instructions.push(new TransactionInstruction({ programId: PUMP_AMM_PROGRAM_ID, keys: this.buildSwapKeys(sa, user), data }));
    instructions.push(createCloseAccountInstruction(sa.userQuoteTokenAccount, user, user, undefined, TOKEN_PROGRAM_ID));
    return instructions;
  }

  private async updateTrackerPnl(realizedPnl: number): Promise<void> {
    const stateCol = await getCollection<KolTrackerStateDoc>('kol_tracker_state');
    const state = await stateCol.findOne({ _id: 'kol_tracker_state' as any });
    if (!state) return;

    const newTotalPnl = (state.totalRealizedPnlSOL || 0) + realizedPnl;
    const newTier = calculateTier(newTotalPnl, state.currentTier || 0);

    if (newTier !== state.currentTier) {
      logger.info(`[MirrorTrader] TIER UP! ${state.currentTier} -> ${newTier} (PnL: ${newTotalPnl.toFixed(4)} SOL)`);
    }

    await stateCol.updateOne(
      { _id: 'kol_tracker_state' as any },
      { $set: { totalRealizedPnlSOL: newTotalPnl, currentTier: newTier } },
    );
  }
}
