// Pay-per-request access to precise interference data, following the x402
// "exact" scheme shape (HTTP 402 + X-PAYMENT / X-PAYMENT-RESPONSE headers).
//
// The client sends a signed Solana transaction containing a USDC TransferChecked
// to the seller's associated token account. We check the transfer, broadcast it,
// wait for confirmation and only then return the data. Each transaction can pay
// for one request. A hosted x402 facilitator can replace verifyAndSettle() later
// without changing the HTTP contract.
//
// PAYMENT_MODE=demo additionally accepts {"payload":{"demo":true}} so the flow can
// be shown offline; responses are then marked "demo": true.

import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';

export const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const TRANSFER_CHECKED = 12;

export class Paywall {
  constructor({ mode, connection, payTo, asset = DEVNET_USDC, price = 10_000n, decimals = 6, network = 'solana-devnet' }) {
    this.mode = mode;
    this.connection = connection;
    this.payTo = payTo ? new PublicKey(payTo) : null;
    this.asset = new PublicKey(asset);
    this.price = BigInt(price);
    this.decimals = decimals;
    this.network = network;
    this.used = new Set();
  }

  requirements(resource, description) {
    return {
      scheme: 'exact',
      network: this.network,
      maxAmountRequired: this.price.toString(),
      resource,
      description,
      mimeType: 'application/json',
      payTo: this.payTo?.toBase58() ?? null,
      maxTimeoutSeconds: 60,
      asset: this.asset.toBase58(),
      extra: { decimals: this.decimals, priceUsd: Number(this.price) / 10 ** this.decimals, demoAccepted: this.mode === 'demo' },
    };
  }

  /** Returns a receipt when paid; otherwise writes the 402 (or error) response and returns null. */
  async gate(req, res, resource, description) {
    const header = req.headers['x-payment'];
    const reqs = this.requirements(resource, description);
    const reject = (status, error) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ x402Version: 1, error, accepts: [reqs] }));
      return null;
    };
    if (!header) return reject(402, 'X-PAYMENT header is required');

    let payment;
    try {
      payment = JSON.parse(Buffer.from(String(header), 'base64').toString('utf8'));
    } catch {
      return reject(400, 'X-PAYMENT is not base64 JSON');
    }

    if (payment?.payload?.demo) {
      if (this.mode !== 'demo') return reject(402, 'demo payments are disabled');
      return { demo: true, network: this.network, transaction: null, payer: null };
    }

    if (!this.connection || !this.payTo) return reject(503, 'on-chain payments not configured (set PAY_TO and SOLANA_RPC)');
    if (payment.scheme !== 'exact' || payment.network !== this.network) return reject(402, 'unsupported scheme or network');

    try {
      return await this.verifyAndSettle(Buffer.from(payment.payload.transaction, 'base64'));
    } catch (e) {
      return reject(402, `payment rejected: ${e.message}`);
    }
  }

  async verifyAndSettle(raw) {
    const tx = VersionedTransaction.deserialize(raw);
    const sig = bs58.encode(tx.signatures[0]);
    if (this.used.has(sig)) throw new Error('payment already used');

    const keys = tx.message.staticAccountKeys;
    const expectedDest = getAssociatedTokenAddressSync(this.asset, this.payTo, true);
    let paid = null;
    for (const ix of tx.message.compiledInstructions) {
      if (!keys[ix.programIdIndex].equals(TOKEN_PROGRAM_ID)) continue;
      const data = Buffer.from(ix.data);
      if (data[0] !== TRANSFER_CHECKED) continue;
      const [source, mint, dest, owner] = ix.accountKeyIndexes.map((i) => keys[i]);
      const amount = data.readBigUInt64LE(1);
      if (mint.equals(this.asset) && dest.equals(expectedDest) && amount >= this.price && data[9] === this.decimals) {
        paid = { source, owner, amount };
        break;
      }
    }
    if (!paid) throw new Error(`no TransferChecked of >= ${this.price} to ${expectedDest.toBase58()}`);

    this.used.add(sig);
    await this.connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed' });
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const { value } = await this.connection.getSignatureStatuses([sig]);
      const st = value[0];
      if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`);
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
        return { demo: false, network: this.network, transaction: sig, payer: paid.owner.toBase58(), amount: paid.amount.toString() };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('payment not confirmed in time');
  }

  static responseHeader(receipt) {
    return Buffer.from(JSON.stringify({ success: true, ...receipt })).toString('base64');
  }
}
