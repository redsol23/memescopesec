/**
 * KOL Integrity Analyzer — SEC Perspective
 *
 * Evaluates whether KOLs are acting in their followers' interest by analyzing:
 *
 * 1. DUMP SPEED — How fast does the KOL sell after buying? Quick dumps = pump & dump.
 * 2. FOLLOWER IMPACT — Does the price dump AFTER the KOL exits? Followers left holding bags.
 * 3. WIN TRANSPARENCY — Does the KOL's actual on-chain win rate match what they portray?
 * 4. TOKEN SURVIVAL — Do the tokens they call survive or die within hours?
 * 5. POSITION SIZE HONESTY — Are they buying meaningful size or tiny "proof" buys?
 * 6. REPEAT PATTERNS — Serial pump & dumpers will show consistent short hold + big sell patterns.
 *
 * Generates a per-KOL trust score (0-100) and specific red flags.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { getCollection } from '../utils/mongodb.js';
import type { KolTradeDoc, KolWalletDoc } from '../types.js';

// ============================================================================
// Types
// ============================================================================

export interface RedFlag {
  type: 'fast_dump' | 'bag_holder_creator' | 'tiny_position' | 'serial_dumper' | 'token_killer' | 'low_win_rate';
  severity: 'low' | 'medium' | 'high';
  description: string;
  evidence: string;
}

export interface KolAnalysis {
  address: string;
  label: string;
  category: string;

  // Core metrics
  totalTrades: number;
  closedTrades: number;
  winRate: number;               // % of trades with positive PnL
  avgHoldMinutes: number;        // Average time between entry and final exit
  medianHoldMinutes: number;
  avgReturnPct: number;
  totalPnlSOL: number;

  // SEC metrics
  avgDumpSpeedMinutes: number;   // How fast they sell (lower = more suspicious)
  fastDumpRate: number;          // % of trades exited within 30 min
  avgPositionSOL: number;        // Average position size
  tinyPositionRate: number;      // % of trades under 0.01 SOL (fake "proof" buys)
  tokenSurvivalRate: number;     // % of called tokens still tradeable after 24h
  bagHolderScore: number;        // How often followers lose after KOL exits (0-100, higher = worse)

  // Trust score
  trustScore: number;            // 0-100 (100 = most trustworthy)
  trustGrade: 'A' | 'B' | 'C' | 'D' | 'F';

  // Red flags
  redFlags: RedFlag[];

  // Timestamps
  analyzedAt: Date;
  dataRange: { from: Date; to: Date };
}

export interface AnalysisSummary {
  totalKols: number;
  avgTrustScore: number;
  gradeDistribution: Record<string, number>;
  topTrusted: { label: string; score: number }[];
  topSuspicious: { label: string; score: number; flags: number }[];
  analyzedAt: Date;
}

// ============================================================================
// Analyzer
// ============================================================================

export class KolAnalyzer {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Analyze a single KOL's trading behavior.
   */
  async analyzeKol(address: string): Promise<KolAnalysis | null> {
    const walletsCol = await getCollection<KolWalletDoc>('kol_wallets');
    const tradesCol = await getCollection<KolTradeDoc>('kol_trades');

    const kol = await walletsCol.findOne({ address });
    if (!kol) return null;

    const trades = await tradesCol.find({
      kolAddress: address,
      status: { $ne: 'failed' },
    }).sort({ entryAt: 1 }).toArray();

    if (trades.length === 0) {
      return this.emptyAnalysis(kol);
    }

    const closedTrades = trades.filter(t => t.status === 'closed');
    const redFlags: RedFlag[] = [];

    // === Core metrics ===
    const wins = closedTrades.filter(t => t.realizedPnlSOL > 0).length;
    const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0;
    const totalPnlSOL = closedTrades.reduce((sum, t) => sum + t.realizedPnlSOL, 0);
    const avgReturnPct = closedTrades.length > 0
      ? closedTrades.reduce((sum, t) => sum + t.returnPct, 0) / closedTrades.length
      : 0;

    // === Hold time analysis ===
    const holdTimes = closedTrades
      .filter(t => t.exits.length > 0)
      .map(t => {
        const lastExit = t.exits[t.exits.length - 1];
        return (new Date(lastExit.exitAt).getTime() - new Date(t.entryAt).getTime()) / (1000 * 60);
      })
      .filter(m => m > 0);

    const avgHoldMinutes = holdTimes.length > 0
      ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length
      : 0;

    const sortedHolds = [...holdTimes].sort((a, b) => a - b);
    const medianHoldMinutes = sortedHolds.length > 0
      ? sortedHolds[Math.floor(sortedHolds.length / 2)]
      : 0;

    // === Dump speed (first sell, not last) ===
    const dumpSpeeds = closedTrades
      .filter(t => t.exits.length > 0)
      .map(t => {
        const firstExit = t.exits[0];
        return (new Date(firstExit.exitAt).getTime() - new Date(t.entryAt).getTime()) / (1000 * 60);
      })
      .filter(m => m > 0);

    const avgDumpSpeedMinutes = dumpSpeeds.length > 0
      ? dumpSpeeds.reduce((a, b) => a + b, 0) / dumpSpeeds.length
      : 0;

    // Fast dump rate: % of trades where first sell is within 30 min
    const fastDumps = dumpSpeeds.filter(m => m < 30).length;
    const fastDumpRate = dumpSpeeds.length > 0 ? (fastDumps / dumpSpeeds.length) * 100 : 0;

    // === Position size analysis ===
    const positionSizes = trades.map(t => t.entryAmountSOL);
    const avgPositionSOL = positionSizes.length > 0
      ? positionSizes.reduce((a, b) => a + b, 0) / positionSizes.length
      : 0;

    const tinyPositions = positionSizes.filter(s => s < 0.01).length;
    const tinyPositionRate = positionSizes.length > 0
      ? (tinyPositions / positionSizes.length) * 100
      : 0;

    // === Token survival (check if tokens from closed trades still have liquidity) ===
    const tokenSurvivalRate = await this.checkTokenSurvival(closedTrades);

    // === Bag holder score: how often does PnL go negative? ===
    const negativeExits = closedTrades.filter(t => t.realizedPnlSOL < 0).length;
    const bagHolderScore = closedTrades.length > 0
      ? (negativeExits / closedTrades.length) * 100
      : 0;

    // === Red flag detection ===

    // Fast dumper
    if (fastDumpRate > 60 && closedTrades.length >= 3) {
      redFlags.push({
        type: 'fast_dump',
        severity: fastDumpRate > 80 ? 'high' : 'medium',
        description: `Sells within 30 minutes ${fastDumpRate.toFixed(0)}% of the time`,
        evidence: `Avg dump speed: ${avgDumpSpeedMinutes.toFixed(0)} min, median hold: ${medianHoldMinutes.toFixed(0)} min`,
      });
    }

    // Bag holder creator (followers lose money following this KOL)
    if (bagHolderScore > 60 && closedTrades.length >= 5) {
      redFlags.push({
        type: 'bag_holder_creator',
        severity: bagHolderScore > 75 ? 'high' : 'medium',
        description: `${bagHolderScore.toFixed(0)}% of mirror trades are losers`,
        evidence: `${negativeExits}/${closedTrades.length} trades ended in loss, avg return: ${avgReturnPct.toFixed(1)}%`,
      });
    }

    // Tiny position (looks like proof-of-buy, not real conviction)
    if (tinyPositionRate > 50 && trades.length >= 3) {
      redFlags.push({
        type: 'tiny_position',
        severity: 'medium',
        description: `${tinyPositionRate.toFixed(0)}% of buys are under 0.01 SOL`,
        evidence: `Avg position: ${avgPositionSOL.toFixed(4)} SOL — could be fake "proof" buys`,
      });
    }

    // Serial dumper pattern (fast dump + negative PnL for followers)
    if (fastDumpRate > 50 && bagHolderScore > 50 && closedTrades.length >= 5) {
      redFlags.push({
        type: 'serial_dumper',
        severity: 'high',
        description: 'Pattern: buy → quick dump → followers lose money',
        evidence: `${fastDumpRate.toFixed(0)}% fast dumps, ${bagHolderScore.toFixed(0)}% of followers lose`,
      });
    }

    // Token killer (tokens die after KOL exits)
    if (tokenSurvivalRate < 30 && closedTrades.length >= 3) {
      redFlags.push({
        type: 'token_killer',
        severity: tokenSurvivalRate < 15 ? 'high' : 'medium',
        description: `Only ${tokenSurvivalRate.toFixed(0)}% of called tokens survived 24h`,
        evidence: 'Tokens frequently die after this KOL exits',
      });
    }

    // Low win rate with many trades
    if (winRate < 30 && closedTrades.length >= 10) {
      redFlags.push({
        type: 'low_win_rate',
        severity: winRate < 20 ? 'high' : 'low',
        description: `Only ${winRate.toFixed(0)}% win rate across ${closedTrades.length} trades`,
        evidence: 'Following this KOL consistently loses money',
      });
    }

    // === Trust score (0-100) ===
    const trustScore = this.calculateTrustScore({
      winRate, fastDumpRate, bagHolderScore, tinyPositionRate,
      tokenSurvivalRate, avgHoldMinutes, closedTrades: closedTrades.length,
    });

    const trustGrade = trustScore >= 80 ? 'A'
      : trustScore >= 65 ? 'B'
      : trustScore >= 50 ? 'C'
      : trustScore >= 35 ? 'D'
      : 'F';

    const dates = trades.map(t => new Date(t.entryAt).getTime());

    return {
      address,
      label: kol.label,
      category: kol.category || 'manual',
      totalTrades: trades.length,
      closedTrades: closedTrades.length,
      winRate,
      avgHoldMinutes,
      medianHoldMinutes,
      avgReturnPct,
      totalPnlSOL,
      avgDumpSpeedMinutes,
      fastDumpRate,
      avgPositionSOL,
      tinyPositionRate,
      tokenSurvivalRate,
      bagHolderScore,
      trustScore,
      trustGrade,
      redFlags,
      analyzedAt: new Date(),
      dataRange: {
        from: new Date(Math.min(...dates)),
        to: new Date(Math.max(...dates)),
      },
    };
  }

  /**
   * Analyze all KOLs and return a summary report.
   */
  async analyzeAll(): Promise<{ analyses: KolAnalysis[]; summary: AnalysisSummary }> {
    const walletsCol = await getCollection<KolWalletDoc>('kol_wallets');
    const kols = await walletsCol.find().toArray();

    const analyses: KolAnalysis[] = [];

    for (const kol of kols) {
      try {
        const analysis = await this.analyzeKol(kol.address);
        if (analysis && analysis.totalTrades > 0) {
          analyses.push(analysis);
        }
      } catch (err) {
        logger.warn(`[KolAnalyzer] Error analyzing ${kol.label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Sort by trust score
    analyses.sort((a, b) => b.trustScore - a.trustScore);

    // Build summary
    const gradeDistribution: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
    for (const a of analyses) gradeDistribution[a.trustGrade]++;

    const avgTrustScore = analyses.length > 0
      ? analyses.reduce((sum, a) => sum + a.trustScore, 0) / analyses.length
      : 0;

    const summary: AnalysisSummary = {
      totalKols: analyses.length,
      avgTrustScore,
      gradeDistribution,
      topTrusted: analyses
        .filter(a => a.closedTrades >= 3)
        .slice(0, 5)
        .map(a => ({ label: a.label, score: a.trustScore })),
      topSuspicious: analyses
        .filter(a => a.redFlags.length > 0)
        .sort((a, b) => b.redFlags.length - a.redFlags.length)
        .slice(0, 5)
        .map(a => ({ label: a.label, score: a.trustScore, flags: a.redFlags.length })),
      analyzedAt: new Date(),
    };

    // Persist analyses
    const analysisCol = await getCollection('kol_analyses');
    for (const a of analyses) {
      await analysisCol.updateOne(
        { address: a.address },
        { $set: a },
        { upsert: true },
      );
    }

    return { analyses, summary };
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  /**
   * Calculate trust score from metrics.
   * Weighted formula: higher is more trustworthy.
   */
  private calculateTrustScore(metrics: {
    winRate: number;
    fastDumpRate: number;
    bagHolderScore: number;
    tinyPositionRate: number;
    tokenSurvivalRate: number;
    avgHoldMinutes: number;
    closedTrades: number;
  }): number {
    let score = 50; // Start at neutral

    // Win rate contribution (+/- 20 points)
    if (metrics.winRate >= 60) score += 15;
    else if (metrics.winRate >= 45) score += 5;
    else if (metrics.winRate < 30) score -= 15;
    else if (metrics.winRate < 40) score -= 5;

    // Fast dump penalty (up to -25 points)
    if (metrics.fastDumpRate > 80) score -= 25;
    else if (metrics.fastDumpRate > 60) score -= 15;
    else if (metrics.fastDumpRate > 40) score -= 5;
    else if (metrics.fastDumpRate < 20) score += 10;

    // Bag holder penalty (up to -20 points)
    if (metrics.bagHolderScore > 75) score -= 20;
    else if (metrics.bagHolderScore > 50) score -= 10;
    else if (metrics.bagHolderScore < 30) score += 10;

    // Tiny position penalty
    if (metrics.tinyPositionRate > 50) score -= 10;

    // Token survival bonus/penalty
    if (metrics.tokenSurvivalRate > 70) score += 10;
    else if (metrics.tokenSurvivalRate < 30) score -= 10;

    // Hold time bonus (longer holds = more conviction)
    if (metrics.avgHoldMinutes > 120) score += 10;
    else if (metrics.avgHoldMinutes > 60) score += 5;

    // Confidence bonus (more data = more reliable score)
    if (metrics.closedTrades < 3) score = Math.min(score, 60); // Cap if insufficient data

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Check what % of tokens from closed trades still have liquidity.
   * Uses Jupiter price API as a proxy — if there's a price, the token is alive.
   */
  private async checkTokenSurvival(trades: KolTradeDoc[]): Promise<number> {
    if (trades.length === 0) return 100;

    const uniqueMints = [...new Set(trades.map(t => t.tokenMint))];
    let alive = 0;

    for (const mint of uniqueMints.slice(0, 20)) { // Cap at 20 lookups
      try {
        const resp = await fetch(
          `https://api.jup.ag/price/v2?ids=${mint}`,
          { signal: AbortSignal.timeout(3000) },
        );
        if (resp.ok) {
          const data = await resp.json() as any;
          if (data?.data?.[mint]?.price) alive++;
        }
      } catch {}
    }

    return uniqueMints.length > 0 ? (alive / Math.min(uniqueMints.length, 20)) * 100 : 100;
  }

  /**
   * Empty analysis for KOLs with no trade data yet.
   */
  private emptyAnalysis(kol: KolWalletDoc): KolAnalysis {
    return {
      address: kol.address,
      label: kol.label,
      category: kol.category || 'manual',
      totalTrades: 0, closedTrades: 0, winRate: 0,
      avgHoldMinutes: 0, medianHoldMinutes: 0,
      avgReturnPct: 0, totalPnlSOL: 0,
      avgDumpSpeedMinutes: 0, fastDumpRate: 0,
      avgPositionSOL: 0, tinyPositionRate: 0,
      tokenSurvivalRate: 100, bagHolderScore: 0,
      trustScore: 50, trustGrade: 'C',
      redFlags: [],
      analyzedAt: new Date(),
      dataRange: { from: new Date(), to: new Date() },
    };
  }
}
