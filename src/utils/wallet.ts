/**
 * Wallet utilities — key derivation and management for Solana.
 */

import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { logger } from './logger.js';

/**
 * Derive a Solana Keypair at a specific BIP-44 index from a mnemonic.
 */
export function deriveSolanaKeypair(mnemonic: string, index: number): Keypair | null {
  try {
    const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!bip39.validateMnemonic(normalized)) {
      logger.error('Invalid mnemonic phrase');
      return null;
    }

    const seed = bip39.mnemonicToSeedSync(normalized);
    const seedHex = seed.toString('hex');
    const solanaPath = `m/44'/501'/${index}'/0'`;
    const derivedSeed = derivePath(solanaPath, seedHex).key;
    return Keypair.fromSeed(derivedSeed);
  } catch (error) {
    logger.error(`Failed to derive Solana keypair at index ${index}: ${error}`);
    return null;
  }
}

/**
 * Simple wallet wrapper for signing transactions.
 */
export class WalletManager {
  private keypair: Keypair;
  private connection: Connection;
  public publicKey: PublicKey;

  constructor(keypair: Keypair, rpcUrl: string) {
    this.keypair = keypair;
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.publicKey = keypair.publicKey;
  }

  getKeypair(): Keypair {
    return this.keypair;
  }

  getConnection(): Connection {
    return this.connection;
  }

  async getBalance(): Promise<number> {
    const balance = await this.connection.getBalance(this.publicKey);
    return balance / LAMPORTS_PER_SOL;
  }
}
