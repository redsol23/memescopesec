/**
 * Kolscan Scraper — Fetches KOL wallets from kolscan.io.
 */

import { logger } from '../utils/logger.js';
import { getCollection } from '../utils/mongodb.js';
import { config } from '../config.js';
import type { KolWalletDoc } from '../types.js';

const KOLSCAN_URL = 'https://kolscan.io';

interface ScrapedKol {
  address: string;
  label: string;
  rank: number;
}

export async function scrapeKolscan(): Promise<ScrapedKol[]> {
  logger.info('[KolscanScraper] Scraping kolscan.io...');

  const apiUrls = [
    'https://api.kolscan.io/api/kols?sort=pnl&order=desc&limit=30',
    'https://kolscan.io/api/kols?sort=pnl&order=desc&limit=30',
    'https://api.kolscan.io/v1/kols?sort=pnl&limit=30',
  ];

  for (const url of apiUrls) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Origin': KOLSCAN_URL,
          'Referer': `${KOLSCAN_URL}/`,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) continue;
      const data = await response.json() as any;
      const kols = extractKols(data);
      if (kols.length > 0) {
        logger.info(`[KolscanScraper] Got ${kols.length} KOLs from API`);
        return kols;
      }
    } catch (err) {
      logger.debug(`[KolscanScraper] API ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fallback: scrape HTML for embedded data
  try {
    const response = await fetch(KOLSCAN_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', 'Accept': 'text/html' },
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok) {
      const html = await response.text();
      const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
      if (nextDataMatch) {
        const kols = extractKols(JSON.parse(nextDataMatch[1]));
        if (kols.length > 0) { logger.info(`[KolscanScraper] Got ${kols.length} KOLs from embedded data`); return kols; }
      }
    }
  } catch (err) {
    logger.warn(`[KolscanScraper] HTML scrape failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  logger.warn('[KolscanScraper] All methods failed. Use manual add.');
  return [];
}

function extractKols(data: any): ScrapedKol[] {
  const items = Array.isArray(data) ? data
    : Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.kols) ? data.kols
    : Array.isArray(data?.results) ? data.results
    : Array.isArray(data?.props?.pageProps?.kols) ? data.props.pageProps.kols
    : null;

  if (!items) return [];
  return items.map((item: any, i: number) => {
    const address = item.address || item.wallet || item.walletAddress || item.pubkey;
    if (!address || typeof address !== 'string') return null;
    return { address, label: item.name || item.label || item.twitter || `KOL #${i + 1}`, rank: item.rank || i + 1 };
  }).filter(Boolean) as ScrapedKol[];
}

export async function refreshKolsFromKolscan(): Promise<{ added: number; updated: number; total: number }> {
  const scraped = await scrapeKolscan();
  if (scraped.length === 0) return { added: 0, updated: 0, total: 0 };

  const walletsCol = await getCollection<KolWalletDoc>('kol_wallets');
  let added = 0, updated = 0;

  for (const kol of scraped) {
    const existing = await walletsCol.findOne({ address: kol.address });
    if (existing) {
      await walletsCol.updateOne({ address: kol.address }, { $set: { kolscanRank: kol.rank, ...(kol.label !== `KOL #${kol.rank}` ? { label: kol.label } : {}) } });
      updated++;
    } else {
      await walletsCol.insertOne({
        address: kol.address, label: kol.label, enabled: true, addedAt: new Date(),
        source: 'kolscan', kolscanRank: kol.rank,
        exitStrategy: { ...config.defaultExitStrategy },
        stats: { totalTrades: 0, wins: 0, losses: 0, totalPnlSOL: 0, avgReturnPct: 0, lastTradeAt: null },
      });
      added++;
    }
  }

  logger.info(`[KolscanScraper] Refresh: ${added} added, ${updated} updated, ${scraped.length} total`);
  return { added, updated, total: scraped.length };
}
