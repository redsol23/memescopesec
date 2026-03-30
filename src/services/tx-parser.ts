/**
 * Transaction Parser — Identifies pump.fun / PumpSwap buys and sells.
 */

import { type ParsedTransactionWithMeta, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import type { ParsedPumpTrade } from '../types.js';

const PUMP_SWAP_AMM = config.pumpSwapAmmProgramId;
const PUMP_FUN_BONDING = config.pumpFunBondingCurveProgramId;
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export function parsePumpFunTransaction(
  tx: ParsedTransactionWithMeta,
  signature: string,
  traderAddress: string,
): ParsedPumpTrade | null {
  if (!tx || !tx.meta || tx.meta.err) return null;

  const accountKeys = tx.transaction.message.accountKeys.map(k =>
    typeof k === 'string' ? k : k.pubkey.toBase58()
  );

  const involvesPumpSwap = accountKeys.includes(PUMP_SWAP_AMM);
  const involvesPumpFun = accountKeys.includes(PUMP_FUN_BONDING);

  if (!involvesPumpSwap && !involvesPumpFun) return null;

  // Also check inner instructions' program IDs
  const allProgramIds = new Set<string>();
  for (const ix of tx.transaction.message.instructions) {
    const pid = 'programId' in ix ? ix.programId.toBase58() : '';
    allProgramIds.add(pid);
  }
  if (tx.meta.innerInstructions) {
    for (const inner of tx.meta.innerInstructions) {
      for (const ix of inner.instructions) {
        const pid = 'programId' in ix ? ix.programId.toBase58() : '';
        allProgramIds.add(pid);
      }
    }
  }

  if (!allProgramIds.has(PUMP_SWAP_AMM) && !allProgramIds.has(PUMP_FUN_BONDING)) return null;

  const preBalances = tx.meta.preBalances;
  const postBalances = tx.meta.postBalances;
  const preTokenBalances = tx.meta.preTokenBalances || [];
  const postTokenBalances = tx.meta.postTokenBalances || [];

  const traderIndex = accountKeys.indexOf(traderAddress);
  if (traderIndex === -1) return null;

  const solChange = (postBalances[traderIndex] - preBalances[traderIndex]) / LAMPORTS_PER_SOL;

  let tokenMint: string | null = null;
  let tokenChange = 0;

  for (const post of postTokenBalances) {
    if (post.owner !== traderAddress) continue;
    if (post.mint === WSOL_MINT) continue;

    const postAmount = parseFloat(post.uiTokenAmount.uiAmountString || '0');
    const pre = preTokenBalances.find(p => p.owner === traderAddress && p.mint === post.mint);
    const preAmount = pre ? parseFloat(pre.uiTokenAmount.uiAmountString || '0') : 0;
    const change = postAmount - preAmount;

    if (Math.abs(change) > 0) {
      tokenMint = post.mint;
      tokenChange = change;
      break;
    }
  }

  // Check for tokens fully sold (not in postTokenBalances)
  if (!tokenMint) {
    for (const pre of preTokenBalances) {
      if (pre.owner !== traderAddress) continue;
      if (pre.mint === WSOL_MINT) continue;

      const post = postTokenBalances.find(p => p.owner === traderAddress && p.mint === pre.mint);
      if (!post) {
        tokenMint = pre.mint;
        tokenChange = -parseFloat(pre.uiTokenAmount.uiAmountString || '0');
        break;
      }
    }
  }

  if (!tokenMint) return null;

  const direction: 'buy' | 'sell' = tokenChange > 0 ? 'buy' : 'sell';
  const solAmount = Math.abs(solChange);
  const tokenAmount = Math.abs(tokenChange);

  if (solAmount < 0.0001 && tokenAmount < 0.0001) return null;

  const blockTime = tx.blockTime || Math.floor(Date.now() / 1000);

  logger.info(
    `[TxParser] pump.fun ${direction}: ${tokenAmount.toFixed(2)} tokens ` +
    `for ${solAmount.toFixed(4)} SOL (mint: ${tokenMint.slice(0, 8)}...) ` +
    `by ${traderAddress.slice(0, 8)}...`
  );

  return { signature, tokenMint, direction, solAmount, tokenAmount, timestamp: blockTime, trader: traderAddress };
}
