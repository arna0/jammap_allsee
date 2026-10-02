// One-time devnet setup after `anchor deploy`:
//   1. creates .keys/relayer.json and .keys/buyer.json (if missing) and airdrops SOL
//   2. creates the JAM reward mint (6 decimals) and initializes the program config + vault
//   3. mints 1,000,000 JAM into the vault
//
//   JAMMAP_PROGRAM_ID=<id> node scripts/setup-devnet.js
// The relayer keypair becomes the program authority; keep .keys/ out of git.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createMint, mintTo } from '@solana/spl-token';

const programId = new PublicKey(process.env.JAMMAP_PROGRAM_ID || process.argv[2] || '');
const conn = new Connection(process.env.SOLANA_RPC || 'https://api.devnet.solana.com', 'confirmed');

function keypair(file) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync('.keys', { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Array.from(Keypair.generate().secretKey)));
    console.log(`created ${file}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
}

async function fund(kp, min = 1) {
  const bal = await conn.getBalance(kp.publicKey);
  if (bal >= min * LAMPORTS_PER_SOL) return;
  try {
    const sig = await conn.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
    console.log(`airdropped 2 SOL to ${kp.publicKey.toBase58()}`);
  } catch (e) {
    console.log(`airdrop failed (${e.message}). Fund ${kp.publicKey.toBase58()} at https://faucet.solana.com and re-run.`);
    process.exit(1);
  }
}

const disc = (name) => crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

async function main() {
  const relayer = keypair('.keys/relayer.json');
  const buyer = keypair('.keys/buyer.json');
  await fund(relayer);
  await fund(buyer, 0.2);

  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault')], programId);
  if (await conn.getAccountInfo(config)) {
    console.log(`config already initialized at ${config.toBase58()}`);
  } else {
    const mint = await createMint(conn, relayer, relayer.publicKey, null, 6);
    console.log(`JAM reward mint: ${mint.toBase58()}`);
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      // reward 1 JAM per confirmed vote, quorum 3, 300 s windows
      data: Buffer.concat([disc('initialize'), u64(1_000_000), Buffer.from([3]), u64(300)]),
    });
    const sig = await conn.sendTransaction(new Transaction().add(ix), [relayer]);
    await conn.confirmTransaction(sig, 'confirmed');
    console.log(`initialized config ${config.toBase58()} (tx ${sig})`);
    await mintTo(conn, relayer, mint, vault, relayer, 1_000_000n * 1_000_000n);
    console.log('minted 1,000,000 JAM into the vault');
  }

  console.log(`
Done. Add to server/.env:
  JAMMAP_PROGRAM_ID=${programId.toBase58()}
  RELAYER_KEYPAIR=.keys/relayer.json
Buyer wallet for the x402 demo: ${buyer.publicKey.toBase58()}
  → get devnet USDC at https://faucet.circle.com (Solana Devnet)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
