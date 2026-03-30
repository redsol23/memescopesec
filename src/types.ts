/**
 * MemeScope SEC — Type Definitions
 */

import type { ObjectId } from 'mongodb';

// ============================================================================
// KOL Wallet Configuration
// ============================================================================

export interface ExitStrategy {
  sellPct1: number;           // % to sell at target1 (e.g. 50)
  target1Multiplier: number;  // e.g. 2 (sell at 2x)
  sellPct2: number;           // % to sell at target2 (e.g. 100 = remaining)
  target2Multiplier: number;  // e.g. 4 (sell at 4x)
  maxHoldMinutes: number;     // Force sell after N minutes (e.g. 240 = 4h)
}

export interface KolStats {
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnlSOL: number;
  avgReturnPct: number;
  lastTradeAt: Date | null;
}

export interface KolWalletDoc {
  _id?: ObjectId;
  address: string;            // Solana pubkey
  label: string;              // "Ansem", "Murad", etc.
  enabled: boolean;
  addedAt: Date;
  source: 'kolscan' | 'manual';
  kolscanRank?: number;
  exitStrategy: ExitStrategy;
  stats: KolStats;
}

// ============================================================================
// KOL Trades
// ============================================================================

export interface TradeExit {
  signature: string;
  tokensSold: number;
  solReceived: number;
  exitAt: Date;
  reason: 'target1' | 'target2' | 'time_limit' | 'manual';
}

export type TradeStatus = 'open' | 'partial_exit' | 'closed' | 'failed';

export interface KolTradeDoc {
  _id?: ObjectId;
  kolAddress: string;
  kolLabel: string;
  tokenMint: string;
  tokenSymbol?: string;
  status: TradeStatus;

  // Entry
  entrySignature: string;
  mirrorSignature: string;
  entryAmountSOL: number;
  entryTokenAmount: number;
  entryPricePerToken: number;
  entryAt: Date;

  // Exits
  exits: TradeExit[];

  // PnL
  realizedPnlSOL: number;
  unrealizedPnlSOL: number;
  currentPricePerToken: number;
  lastPriceUpdate: Date;
  returnPct: number;

  // Dedup
  kolTxSignature: string;
}

// ============================================================================
// Tracker State (singleton)
// ============================================================================

export interface KolTrackerStateDoc {
  _id: 'kol_tracker_state';
  lastPollPerWallet: Record<string, string>;
  startedAt: Date;
  walletBalanceSOL: number;
  totalRealizedPnlSOL: number;
  currentTier: number;
}

// ============================================================================
// Position Sizing Tiers
// ============================================================================

export interface TierConfig {
  size: number;
  threshold: number;
}

// ============================================================================
// TX Parser Output
// ============================================================================

export interface ParsedPumpTrade {
  signature: string;
  tokenMint: string;
  direction: 'buy' | 'sell';
  solAmount: number;
  tokenAmount: number;
  timestamp: number;
  trader: string;
}

// ============================================================================
// Overall Stats (API response)
// ============================================================================

export interface OverallStats {
  totalKols: number;
  enabledKols: number;
  totalTrades: number;
  openPositions: number;
  totalRealizedPnlSOL: number;
  totalUnrealizedPnlSOL: number;
  winRate: number;
  currentTier: number;
  currentPositionSizeSOL: number;
  walletBalanceSOL: number;
}
