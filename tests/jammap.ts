import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import { assert } from "chai";
import { Jammap } from "../target/types/jammap";

const REPORT_DOMAIN = Buffer.from("jammap:report:v1");
const REGISTER_DOMAIN = Buffer.from("jammap:register:v1");
const WINDOW_SECS = 300;

function u64le(n: bigint | number) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
function i64le(n: bigint | number) {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
}
function reportMessage(cellId: bigint, ts: number, kind: number, severity: number) {
  return Buffer.concat([REPORT_DOMAIN, u64le(cellId), i64le(ts), Buffer.from([kind, severity])]);
}

describe("jammap", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Jammap as Program<Jammap>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const pda = (...seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const configPda = pda(Buffer.from("config"));
  const vaultPda = pda(Buffer.from("vault"));

  let mint: PublicKey;
  const devices = [0, 1, 2, 3].map(() => ({ key: Keypair.generate(), owner: Keypair.generate() }));
  const devicePda = (d: { key: Keypair }) => pda(Buffer.from("device"), d.key.publicKey.toBuffer());

  const cellId = 1_234_567n;
  const ts = Math.floor(Date.now() / 1000);
  const window = BigInt(Math.floor(ts / WINDOW_SECS));
  const incidentPda = pda(Buffer.from("incident"), u64le(cellId), u64le(window));
  const votePda = (d: { key: Keypair }) =>
    pda(Buffer.from("vote"), incidentPda.toBuffer(), devicePda(d).toBuffer());

  async function sendSigned(ed: anchor.web3.TransactionInstruction, ix: anchor.web3.TransactionInstruction) {
    const tx = new Transaction().add(ed, ix);
    return provider.sendAndConfirm(tx, []);
  }

  async function submit(d: (typeof devices)[0], opts: { kind?: number; severity?: number; signer?: Keypair } = {}) {
    const kind = opts.kind ?? 1;
    const severity = opts.severity ?? 2;
    const msg = reportMessage(cellId, ts, kind, severity);
    const signer = opts.signer ?? d.key;
    const ed = Ed25519Program.createInstructionWithPrivateKey({ privateKey: signer.secretKey, message: msg });
    const ix = await program.methods
      .submitReport(new BN(cellId.toString()), new BN(window.toString()), new BN(ts), kind, severity)
      .accountsPartial({
        payer: payer.publicKey,
        config: configPda,
        device: devicePda(d),
        incident: incidentPda,
        vote: votePda(d),
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    return sendSigned(ed, ix);
  }

  before(async () => {
    mint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
  });

  it("initializes config and vault", async () => {
    await program.methods
      .initialize(new BN(1_000_000), 3, new BN(WINDOW_SECS))
      .accountsPartial({
        authority: payer.publicKey,
        config: configPda,
        rewardMint: mint,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await mintTo(provider.connection, payer, mint, vaultPda, payer, 100_000_000);
    const cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.quorum, 3);
  });

  it("registers devices with an ed25519 proof", async () => {
    for (const d of devices) {
      const msg = Buffer.concat([REGISTER_DOMAIN, d.owner.publicKey.toBuffer()]);
      const ed = Ed25519Program.createInstructionWithPrivateKey({ privateKey: d.key.secretKey, message: msg });
      const ix = await program.methods
        .registerDevice(d.key.publicKey, d.owner.publicKey)
        .accountsPartial({
          payer: payer.publicKey,
          config: configPda,
          device: devicePda(d),
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      await sendSigned(ed, ix);
    }
    const dev = await program.account.device.fetch(devicePda(devices[0]));
    assert.ok(dev.owner.equals(devices[0].owner.publicKey));
  });

  it("rejects a report signed by the wrong key", async () => {
    try {
      await submit(devices[0], { signer: Keypair.generate() });
      assert.fail("should have failed");
    } catch (e: any) {
      assert.match(String(e), /WrongSigner|0x1778|custom program error/);
    }
  });

  it("reaches quorum after 3 distinct devices", async () => {
    await submit(devices[0]);
    await submit(devices[1]);
    let inc = await program.account.incident.fetch(incidentPda);
    assert.equal(inc.reporters, 2);
    assert.isFalse(inc.confirmed);

    await submit(devices[2], { kind: 1, severity: 3 });
    inc = await program.account.incident.fetch(incidentPda);
    assert.equal(inc.reporters, 3);
    assert.isTrue(inc.confirmed);
    assert.equal(inc.maxSeverity, 3);
  });

  it("refuses a duplicate vote from the same device", async () => {
    try {
      await submit(devices[0]);
      assert.fail("should have failed");
    } catch (e: any) {
      assert.match(String(e), /already in use|custom program error/);
    }
  });

  it("pays a reward once per confirmed vote", async () => {
    const d = devices[1];
    await provider.connection.requestAirdrop(d.owner.publicKey, 1_000_000_000).then((sig) =>
      provider.connection.confirmTransaction(sig)
    );
    const ata = await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, d.owner.publicKey);
    const claim = () =>
      program.methods
        .claimReward()
        .accountsPartial({
          owner: d.owner.publicKey,
          config: configPda,
          device: devicePda(d),
          incident: incidentPda,
          vote: votePda(d),
          vault: vaultPda,
          ownerToken: ata.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([d.owner])
        .rpc();

    await claim();
    assert.equal((await getAccount(provider.connection, ata.address)).amount, 1_000_000n);
    try {
      await claim();
      assert.fail("should have failed");
    } catch (e: any) {
      assert.match(String(e), /AlreadyClaimed|custom program error/);
    }
  });

  it("signature check binds every field (tampered severity fails)", async () => {
    const d = devices[3];
    const signed = reportMessage(cellId, ts, 1, 1);
    const ed = Ed25519Program.createInstructionWithPublicKey({
      publicKey: d.key.publicKey.toBytes(),
      message: signed,
      signature: nacl.sign.detached(signed, d.key.secretKey),
    });
    const ix = await program.methods
      .submitReport(new BN(cellId.toString()), new BN(window.toString()), new BN(ts), 1, 3)
      .accountsPartial({
        payer: payer.publicKey,
        config: configPda,
        device: devicePda(d),
        incident: incidentPda,
        vote: votePda(d),
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    try {
      await sendSigned(ed, ix);
      assert.fail("should have failed");
    } catch (e: any) {
      assert.match(String(e), /WrongMessage|custom program error/);
    }
  });
});
