// Relayer: pays fees and forwards phone-signed reports to the JamMap program.
// Instructions are built by hand (Anchor discriminator + borsh args) so the
// server does not need the generated IDL to run.

import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  Connection,
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

const disc = (name) => crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const i64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};

export function loadKeypair(file) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
}

export class Chain {
  static fromEnv(env) {
    if (!env.JAMMAP_PROGRAM_ID) return null;
    const keyFile = env.RELAYER_KEYPAIR || '.keys/relayer.json';
    if (!fs.existsSync(keyFile)) {
      console.warn(`[chain] JAMMAP_PROGRAM_ID set but ${keyFile} missing — run "npm run setup:devnet". Chain disabled.`);
      return null;
    }
    return new Chain({
      rpc: env.SOLANA_RPC || 'https://api.devnet.solana.com',
      programId: new PublicKey(env.JAMMAP_PROGRAM_ID),
      relayer: loadKeypair(keyFile),
      cluster: env.SOLANA_CLUSTER || 'devnet',
    });
  }

  constructor({ rpc, programId, relayer, cluster }) {
    this.connection = new Connection(rpc, 'confirmed');
    this.programId = programId;
    this.relayer = relayer;
    this.cluster = cluster;
    this.queue = Promise.resolve();
  }

  pda(...seeds) {
    return PublicKey.findProgramAddressSync(seeds, this.programId)[0];
  }
  get configPda() {
    return this.pda(Buffer.from('config'));
  }
  devicePda(deviceKey) {
    return this.pda(Buffer.from('device'), deviceKey.toBuffer());
  }
  incidentPda(cell, window) {
    return this.pda(Buffer.from('incident'), u64(cell), u64(window));
  }
  votePda(incident, device) {
    return this.pda(Buffer.from('vote'), incident.toBuffer(), device.toBuffer());
  }

  explorer(sig) {
    return `https://explorer.solana.com/tx/${sig}?cluster=${this.cluster}`;
  }

  // Transactions go out one at a time so a burst of reports can't race on the same incident account.
  enqueue(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async send(ixs) {
    const tx = new Transaction().add(...ixs);
    return sendAndConfirmTransaction(this.connection, tx, [this.relayer], { commitment: 'confirmed' });
  }

  registerDevice({ deviceKey, owner, message, signature }) {
    return this.enqueue(async () => {
      const device = this.devicePda(deviceKey);
      if (await this.connection.getAccountInfo(device)) return { tx: null, already: true };
      const ed = Ed25519Program.createInstructionWithPublicKey({ publicKey: deviceKey.toBytes(), message, signature });
      const ix = new TransactionInstruction({
        programId: this.programId,
        keys: [
          { pubkey: this.relayer.publicKey, isSigner: true, isWritable: true },
          { pubkey: this.configPda, isSigner: false, isWritable: true },
          { pubkey: device, isSigner: false, isWritable: true },
          { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([disc('register_device'), deviceKey.toBuffer(), owner.toBuffer()]),
      });
      return { tx: await this.send([ed, ix]) };
    });
  }

  submitReport({ deviceKey, cell, window, ts, kind, severity, message, signature }) {
    return this.enqueue(async () => {
      const device = this.devicePda(deviceKey);
      const incident = this.incidentPda(cell, window);
      const vote = this.votePda(incident, device);
      const ed = Ed25519Program.createInstructionWithPublicKey({ publicKey: deviceKey.toBytes(), message, signature });
      const ix = new TransactionInstruction({
        programId: this.programId,
        keys: [
          { pubkey: this.relayer.publicKey, isSigner: true, isWritable: true },
          { pubkey: this.configPda, isSigner: false, isWritable: true },
          { pubkey: device, isSigner: false, isWritable: true },
          { pubkey: incident, isSigner: false, isWritable: true },
          { pubkey: vote, isSigner: false, isWritable: true },
          { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([disc('submit_report'), u64(cell), u64(window), i64(ts), Buffer.from([kind, severity])]),
      });
      return { tx: await this.send([ed, ix]), incident: incident.toBase58() };
    });
  }
}
