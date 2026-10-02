// x402 buyer: what a drone operator's or fleet's backend does to buy JamMap data.
//
//   node src/buyer.js --lat 42.32 --lon 69.62            # pays 0.01 devnet USDC
//   node src/buyer.js --lat 42.32 --lon 69.62 --demo     # demo payment (server must run with DEMO=1)
//
// Needs a funded devnet keypair (SOL for fees + devnet USDC from https://faucet.circle.com)
// at BUYER_KEYPAIR (default .keys/buyer.json).

import fs from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] == null ? true : all[i + 1]]] : acc), [])
);
const SERVER = args.server || process.env.JAMMAP_SERVER || 'http://127.0.0.1:8787';
const url = `${SERVER}/v1/risk?lat=${args.lat ?? 42.32}&lon=${args.lon ?? 69.62}&radius_km=${args.radius ?? 25}`;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

async function main() {
  console.log(`GET ${url}`);
  const first = await fetch(url);
  if (first.status !== 402) {
    console.log(first.status, await first.text());
    return;
  }
  const { accepts } = await first.json();
  const req = accepts[0];
  console.log(`← 402 Payment Required: ${Number(req.maxAmountRequired) / 10 ** req.extra.decimals} USDC on ${req.network} to ${req.payTo}`);

  let header;
  if (args.demo) {
    header = b64({ x402Version: 1, scheme: 'exact', network: req.network, payload: { demo: true } });
  } else {
    const file = process.env.BUYER_KEYPAIR || '.keys/buyer.json';
    const buyer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
    const conn = new Connection(process.env.SOLANA_RPC || 'https://api.devnet.solana.com', 'confirmed');
    const mint = new PublicKey(req.asset);
    const payTo = new PublicKey(req.payTo);
    const from = getAssociatedTokenAddressSync(mint, buyer.publicKey);
    const to = getAssociatedTokenAddressSync(mint, payTo, true);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, to, payTo, mint),
      createTransferCheckedInstruction(from, mint, to, buyer.publicKey, BigInt(req.maxAmountRequired), req.extra.decimals)
    );
    tx.feePayer = buyer.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.sign(buyer);
    header = b64({ x402Version: 1, scheme: 'exact', network: req.network, payload: { transaction: tx.serialize().toString('base64') } });
    console.log(`→ paying from ${buyer.publicKey.toBase58()}`);
  }

  const paid = await fetch(url, { headers: { 'X-PAYMENT': header } });
  const receipt = paid.headers.get('x-payment-response');
  const body = await paid.json();
  if (paid.status !== 200) {
    console.log(`✗ ${paid.status}`, body.error || body);
    return;
  }
  const r = JSON.parse(Buffer.from(receipt, 'base64').toString());
  console.log(`← 200 OK  ${r.demo ? '(demo payment)' : `payment tx https://explorer.solana.com/tx/${r.transaction}?cluster=devnet`}`);
  console.log(`\nRisk around (${body.query.lat}, ${body.query.lon}) r=${body.query.radiusKm} km: ${body.risk.level.toUpperCase()} (${body.risk.score}/100)`);
  for (const i of body.incidents) {
    const kind = { 1: 'JAMMING', 2: 'SPOOFING', 3: 'JAMMING+SPOOFING' }[i.kinds];
    const src = i.source ? `source ≈ ${i.source.lat.toFixed(4)}, ${i.source.lon.toFixed(4)} ±${i.source.radiusKm} km` : 'source: n/a';
    console.log(`  • ${kind.padEnd(16)} ${i.confirmed ? 'CONFIRMED' : 'pending  '} ${i.reporters} phones, sev ${i.maxSeverity}, ${src}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
