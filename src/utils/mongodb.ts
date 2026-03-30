/**
 * MongoDB Connection Manager — Singleton with lazy connect.
 */

import { MongoClient, Db, Collection, Document } from 'mongodb';
import { logger } from './logger.js';

const DEFAULT_URI = 'mongodb://localhost:27017/memescopesec';

let client: MongoClient | null = null;
let db: Db | null = null;
let connectPromise: Promise<Db> | null = null;

export async function getDb(): Promise<Db> {
  if (db) return db;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    const uri = process.env.MONGODB_URI || DEFAULT_URI;
    logger.info(`[MongoDB] Connecting to ${uri.replace(/\/\/[^@]*@/, '//***@')}...`);

    client = new MongoClient(uri, {
      maxPoolSize: 10,
      minPoolSize: 1,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
    });

    await client.connect();
    db = client.db();
    logger.info(`[MongoDB] Connected to database: ${db.databaseName}`);
    return db;
  })();

  return connectPromise;
}

export async function getCollection<T extends Document = Document>(name: string): Promise<Collection<T>> {
  const database = await getDb();
  return database.collection<T>(name);
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
    connectPromise = null;
  }
}
