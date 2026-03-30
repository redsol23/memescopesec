/**
 * Telegram Alerter — Sends error notifications only.
 */

import { config } from '../config.js';
import { logger } from './logger.js';

const TG_API = 'https://api.telegram.org';

export async function sendTelegramAlert(message: string): Promise<void> {
  if (!config.telegramBotToken || !config.telegramChatId) return;

  try {
    const url = `${TG_API}/bot${config.telegramBotToken}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: `⚠️ MemeScope SEC\n\n${message}`,
        parse_mode: 'HTML',
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    logger.warn(`[Telegram] Failed to send alert: ${err instanceof Error ? err.message : String(err)}`);
  }
}
