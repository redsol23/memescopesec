/**
 * Token Metadata — Fetches name/symbol/image from Jupiter Tokens API.
 * Caches results to avoid redundant lookups.
 */

import { logger } from './logger.js';

const JUPITER_TOKENS_API = 'https://lite-api.jup.ag/tokens/v2';

export interface TokenMeta {
  mint: string;
  name: string;
  symbol: string;
  icon?: string;
  decimals: number;
}

// In-memory cache (survives for process lifetime)
const cache = new Map<string, TokenMeta>();

export async function getTokenMetadata(mint: string): Promise<TokenMeta | null> {
  if (cache.has(mint)) return cache.get(mint)!;

  try {
    const resp = await fetch(`${JUPITER_TOKENS_API}/search?query=${mint}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) return null;

    const data = await resp.json() as any[];
    if (!Array.isArray(data) || data.length === 0) return null;

    // Find exact match by mint address
    const token = data.find((t: any) => t.id === mint || t.address === mint) || data[0];

    const meta: TokenMeta = {
      mint,
      name: token.name || 'Unknown',
      symbol: token.symbol || mint.slice(0, 6),
      icon: token.icon || token.logoURI || undefined,
      decimals: token.decimals ?? 6,
    };

    cache.set(mint, meta);
    logger.debug(`[TokenMeta] ${meta.symbol} (${meta.name}) — ${mint.slice(0, 8)}...`);
    return meta;
  } catch {
    return null;
  }
}

/**
 * Batch fetch metadata for multiple mints.
 */
export async function getTokenMetadataBatch(mints: string[]): Promise<Map<string, TokenMeta>> {
  const results = new Map<string, TokenMeta>();
  const uncached = mints.filter(m => {
    if (cache.has(m)) { results.set(m, cache.get(m)!); return false; }
    return true;
  });

  // Fetch uncached mints (Jupiter supports comma-separated search)
  for (const mint of uncached) {
    const meta = await getTokenMetadata(mint);
    if (meta) results.set(mint, meta);
  }

  return results;
}
