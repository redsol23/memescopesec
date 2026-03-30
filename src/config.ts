/**
 * MemeScope SEC — Configuration
 */

import type { TierConfig, ExitStrategy } from './types.js';

export const config = {
  port: parseInt(process.env.KOL_TRACKER_PORT || '3002', 10),
  walletIndex: parseInt(process.env.KOL_TRACKER_WALLET_INDEX || '4', 10),
  pollIntervalMs: parseInt(process.env.KOL_TRACKER_POLL_INTERVAL_MS || '5000', 10),
  maxSlippageBps: parseInt(process.env.KOL_TRACKER_MAX_SLIPPAGE_BPS || '300', 10),

  tiers: [
    { size: parseFloat(process.env.KOL_TRACKER_TIER0_SIZE || '0.01'), threshold: 0 },
    { size: parseFloat(process.env.KOL_TRACKER_TIER1_SIZE || '0.05'), threshold: parseFloat(process.env.KOL_TRACKER_TIER1_THRESHOLD || '0.5') },
    { size: parseFloat(process.env.KOL_TRACKER_TIER2_SIZE || '0.1'), threshold: parseFloat(process.env.KOL_TRACKER_TIER2_THRESHOLD || '2') },
    { size: parseFloat(process.env.KOL_TRACKER_TIER3_SIZE || '0.5'), threshold: parseFloat(process.env.KOL_TRACKER_TIER3_THRESHOLD || '10') },
    { size: parseFloat(process.env.KOL_TRACKER_TIER4_SIZE || '1.0'), threshold: parseFloat(process.env.KOL_TRACKER_TIER4_THRESHOLD || '25') },
  ] as TierConfig[],

  defaultExitStrategy: {
    sellPct1: 50,
    target1Multiplier: 2,
    sellPct2: 100,
    target2Multiplier: 4,
    maxHoldMinutes: 240,
  } as ExitStrategy,

  pumpSwapAmmProgramId: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  pumpFunBondingCurveProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',

  positionCheckIntervalMs: parseInt(process.env.KOL_TRACKER_POSITION_CHECK_MS || '60000', 10),
};

export function getPositionSizeForTier(tier: number): number {
  const t = config.tiers[Math.min(tier, config.tiers.length - 1)];
  return t.size;
}

export function calculateTier(totalRealizedPnlSOL: number, currentTier: number): number {
  let newTier = 0;
  for (let i = config.tiers.length - 1; i >= 0; i--) {
    if (totalRealizedPnlSOL >= config.tiers[i].threshold) {
      newTier = i;
      break;
    }
  }
  return Math.max(currentTier, newTier);
}
