/**
 * Kolscan Scraper — Scrapes kolscan.io leaderboard across timeframes.
 *
 * Categorizes KOLs into:
 *   - established: Top monthly performers with consistent weekly showing
 *   - rising:      Strong weekly performance but not yet monthly top
 *   - hot:         High daily PnL, fresh momentum
 *
 * Scrapes /leaderboard with timeframe=1 (daily), =7 (weekly), =30 (monthly).
 * Uses Cheerio to parse the server-rendered HTML.
 */

import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.js';
import { getCollection } from '../utils/mongodb.js';
import { config } from '../config.js';
import type { KolWalletDoc, KolCategory, KolscanMetrics } from '../types.js';

const KOLSCAN_LEADERBOARD = 'https://kolscan.io/leaderboard';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface ScrapedKol {
  name: string;
  address: string;
  pnlSOL: number;
  pnlUSD: number;
  wins: number;
  losses: number;
  rank: number;
  twitterUrl?: string;
  pfpUrl?: string;
}

/**
 * Scrape a single timeframe from kolscan leaderboard.
 */
async function scrapeTimeframe(timeframe: 1 | 7 | 30): Promise<ScrapedKol[]> {
  const label = timeframe === 1 ? 'daily' : timeframe === 7 ? 'weekly' : 'monthly';

  try {
    const resp = await fetch(`${KOLSCAN_LEADERBOARD}?timeframe=${timeframe}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      logger.warn(`[KolscanScraper] ${label} fetch failed: HTTP ${resp.status}`);
      return [];
    }

    const html = await resp.text();
    const $ = cheerio.load(html);
    const kols: ScrapedKol[] = [];

    // Select leaderboard user containers
    $('[class*="leaderboard_leaderboardUser__"]').each((i, el) => {
      try {
        const container = $(el);

        // Name from the profile link heading
        const name = container.find('a h1').first().text().trim();
        if (!name) return;

        // Address from profile link href (/profile/ADDRESS)
        const profileHref = container.find('a').first().attr('href') || '';
        const address = profileHref.replace('/profile/', '').trim();
        if (!address || address.length < 32) return;

        // PnL section
        const profitEl = container.find('[class*="leaderboard_totalProfitNum__"]');
        const profitTexts = profitEl.find('h1');
        const solText = profitTexts.eq(0).text().trim().replace(/[+,]/g, '');
        const usdText = profitTexts.eq(1).text().trim().replace(/[$,]/g, '');
        const pnlSOL = parseFloat(solText) || 0;
        const pnlUSD = parseFloat(usdText) || 0;

        // Win/Loss - look for win/loss text patterns
        let wins = 0, losses = 0;
        const allText = container.text();
        const winMatch = allText.match(/(\d+)\s*(?:wins?|W)/i);
        const lossMatch = allText.match(/(\d+)\s*(?:loss(?:es)?|L)/i);
        if (winMatch) wins = parseInt(winMatch[1]);
        if (lossMatch) losses = parseInt(lossMatch[1]);

        // Also try to parse from structured elements
        container.find('[class*="stat"], [class*="win"], [class*="loss"]').each((_, statEl) => {
          const text = $(statEl).text().trim();
          const num = parseInt(text);
          if (!isNaN(num)) {
            if (text.toLowerCase().includes('w') || $(statEl).attr('class')?.includes('win')) wins = num;
            if (text.toLowerCase().includes('l') || $(statEl).attr('class')?.includes('loss')) losses = num;
          }
        });

        // Twitter link
        const twitterUrl = container.find('a[href*="twitter.com"], a[href*="x.com"]').attr('href');

        // Profile picture
        const pfpUrl = container.find('img').first().attr('src');

        kols.push({
          name,
          address,
          pnlSOL,
          pnlUSD,
          wins,
          losses,
          rank: i + 1,
          twitterUrl: twitterUrl || undefined,
          pfpUrl: pfpUrl || undefined,
        });
      } catch {}
    });

    // Fallback: try __NEXT_DATA__ if Cheerio found nothing
    if (kols.length === 0) {
      const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
      if (nextDataMatch) {
        try {
          const nextData = JSON.parse(nextDataMatch[1]);
          const traders = nextData?.props?.pageProps?.traders ||
                         nextData?.props?.pageProps?.leaderboard ||
                         nextData?.props?.pageProps?.data || [];

          if (Array.isArray(traders)) {
            traders.forEach((t: any, i: number) => {
              const addr = t.address || t.wallet || t.walletAddress;
              if (!addr) return;
              kols.push({
                name: t.name || t.label || t.twitter || `KOL #${i + 1}`,
                address: addr,
                pnlSOL: t.pnlSol || t.pnl || t.profit || 0,
                pnlUSD: t.pnlUsd || t.profitUsd || 0,
                wins: t.wins || t.winCount || 0,
                losses: t.losses || t.lossCount || 0,
                rank: i + 1,
                twitterUrl: t.twitterUrl || t.twitter_url,
                pfpUrl: t.pfpUrl || t.avatar,
              });
            });
          }
        } catch {}
      }
    }

    logger.info(`[KolscanScraper] ${label}: scraped ${kols.length} KOLs`);
    return kols;
  } catch (err) {
    logger.warn(`[KolscanScraper] ${label} scrape failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Determine KOL category based on cross-timeframe performance.
 *
 * Established: In monthly top 30 AND weekly top 30 (consistent)
 * Rising:      In weekly top 30 but NOT monthly top 30 (gaining momentum)
 * Hot:         In daily top 30 but not weekly/monthly top 30 (fresh alpha)
 */
function categorizeKol(
  address: string,
  daily: Map<string, ScrapedKol>,
  weekly: Map<string, ScrapedKol>,
  monthly: Map<string, ScrapedKol>,
): KolCategory {
  const inMonthly = monthly.has(address);
  const inWeekly = weekly.has(address);
  const inDaily = daily.has(address);

  if (inMonthly && inWeekly) return 'established';
  if (inWeekly && !inMonthly) return 'rising';
  if (inDaily) return 'hot';
  return 'hot'; // default for anything that made a leaderboard
}

/**
 * Full scrape across all timeframes, categorize, and upsert into DB.
 */
export async function refreshKolsFromKolscan(): Promise<{
  added: number;
  updated: number;
  total: number;
  established: number;
  rising: number;
  hot: number;
}> {
  logger.info('[KolscanScraper] Starting full scrape (daily + weekly + monthly)...');

  const [dailyList, weeklyList, monthlyList] = await Promise.all([
    scrapeTimeframe(1),
    scrapeTimeframe(7),
    scrapeTimeframe(30),
  ]);

  // Build lookup maps
  const daily = new Map(dailyList.map(k => [k.address, k]));
  const weekly = new Map(weeklyList.map(k => [k.address, k]));
  const monthly = new Map(monthlyList.map(k => [k.address, k]));

  // Merge all unique addresses
  const allAddresses = new Set([
    ...daily.keys(), ...weekly.keys(), ...monthly.keys(),
  ]);

  if (allAddresses.size === 0) {
    logger.warn('[KolscanScraper] No KOLs scraped across any timeframe');
    return { added: 0, updated: 0, total: 0, established: 0, rising: 0, hot: 0 } as any;
  }

  const walletsCol = await getCollection<KolWalletDoc>('kol_wallets');
  let added = 0, updated = 0;
  const categoryCounts: Record<string, number> = { established: 0, rising: 0, hot: 0 };

  for (const address of allAddresses) {
    const d = daily.get(address);
    const w = weekly.get(address);
    const m = monthly.get(address);
    const best = m || w || d!; // Use the most data-rich source for name/pfp

    const category = categorizeKol(address, daily, weekly, monthly);
    categoryCounts[category]++;

    const metrics: KolscanMetrics = {
      dailyPnlSOL: d?.pnlSOL ?? 0,
      weeklyPnlSOL: w?.pnlSOL ?? 0,
      monthlyPnlSOL: m?.pnlSOL ?? 0,
      dailyWins: d?.wins ?? 0,
      dailyLosses: d?.losses ?? 0,
      weeklyWins: w?.wins ?? 0,
      weeklyLosses: w?.losses ?? 0,
      monthlyWins: m?.wins ?? 0,
      monthlyLosses: m?.losses ?? 0,
      dailyRank: d?.rank,
      weeklyRank: w?.rank,
      monthlyRank: m?.rank,
      lastScraped: new Date(),
    };

    const existing = await walletsCol.findOne({ address });

    if (existing) {
      await walletsCol.updateOne({ address }, {
        $set: {
          category,
          kolscanMetrics: metrics,
          kolscanRank: best.rank,
          ...(best.twitterUrl ? { twitterUrl: best.twitterUrl } : {}),
          ...(best.pfpUrl ? { pfpUrl: best.pfpUrl } : {}),
          // Don't overwrite manual label
          ...(existing.source === 'kolscan' && best.name !== `KOL #${best.rank}` ? { label: best.name } : {}),
        },
      });
      updated++;
    } else {
      await walletsCol.insertOne({
        address,
        label: best.name,
        enabled: true,
        addedAt: new Date(),
        source: 'kolscan',
        category,
        kolscanRank: best.rank,
        kolscanMetrics: metrics,
        twitterUrl: best.twitterUrl,
        pfpUrl: best.pfpUrl,
        exitStrategy: { ...config.defaultExitStrategy },
        stats: { totalTrades: 0, wins: 0, losses: 0, totalPnlSOL: 0, avgReturnPct: 0, lastTradeAt: null },
      });
      added++;
    }
  }

  logger.info(
    `[KolscanScraper] Complete: ${added} added, ${updated} updated, ${allAddresses.size} total ` +
    `(${categoryCounts.established} established, ${categoryCounts.rising} rising, ${categoryCounts.hot} hot)`
  );

  return {
    added, updated, total: allAddresses.size,
    established: categoryCounts.established || 0,
    rising: categoryCounts.rising || 0,
    hot: categoryCounts.hot || 0,
  };
}
