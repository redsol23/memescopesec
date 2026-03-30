import winston from 'winston';
import { mkdirSync } from 'fs';
import { join } from 'path';

const logsDir = join(process.cwd(), 'logs');
try { mkdirSync(logsDir, { recursive: true }); } catch {}

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`),
      ),
    }),
    new winston.transports.File({ filename: join(logsDir, 'memescopesec.log'), maxsize: 10 * 1024 * 1024, maxFiles: 5 }),
    new winston.transports.File({ filename: join(logsDir, 'error.log'), level: 'error', maxsize: 10 * 1024 * 1024, maxFiles: 3 }),
  ],
});
