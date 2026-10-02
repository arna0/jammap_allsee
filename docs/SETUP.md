# Setup guide

Hackathon deadline (Colosseum Crypto World's Fair): **13 October 2026, 06:59 UTC**. Aim to submit on 12 October.

## 1. Run the demo locally (5 minutes)

Requirements: Node.js 20+.

```bash
cd server
npm install
npm run demo
```

Open http://localhost:8787. In a second terminal:

```bash
cd server
npm run sim
```

After about 30 seconds a red zone appears: simulated phones have confirmed a jammer. Click the incident to see the evidence chart. In **Route check**, click two points on the map and press **Check route** to make a paid (x402, demo payment) request.

Windows PowerShell blocks `npm.ps1` by default. Use `npm.cmd` / `npx.cmd`, or run the commands from Git Bash.

## 2. Solana toolchain

Anchor works best on Windows through WSL.

1. In an administrator PowerShell: `wsl --install`, reboot, create the Ubuntu user.
2. In Ubuntu, install Rust, the Solana CLI, Anchor and Node in one step:
   ```bash
   curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash
   ```
3. `cd /mnt/c/Users/<you>/Desktop/solana/jammap`
4. `anchor build`, then `anchor keys sync`, then `anchor build` again.
5. `npm install`, then `anchor test`.

## 3. Deploy to devnet

```bash
solana config set --url devnet
solana-keygen new          # if you have no keypair yet
solana airdrop 2           # or https://faucet.solana.com
anchor deploy --provider.cluster devnet
cd server
JAMMAP_PROGRAM_ID=<program id> node scripts/setup-devnet.js
```

Create `server/.env`:

```
JAMMAP_PROGRAM_ID=<program id>
RELAYER_KEYPAIR=.keys/relayer.json
```

`npm run demo` and `npm run sim` now write every report to Solana, and the dashboard links each one to Solana Explorer.

For a real x402 payment, send devnet USDC from https://faucet.circle.com (Solana Devnet) to the buyer address printed by `setup-devnet`, then run `npm run buy`.

## 4. Android app

1. Install Android Studio: https://developer.android.com/studio
2. Open the `android/` folder. Gradle sync takes a while the first time.
3. On the phone, enable Developer options and USB debugging, connect it, press Run.
4. In the app, enter the relayer address `http://<laptop LAN IP>:8787` (find it with `ipconfig`) and a Solana address for rewards. Tap **Register**, then **Start listening**.
5. Go outside. If the AGC line says "not exposed by this phone", that phone cannot report. Recent Pixel (5+) and Galaxy (S21+) phones usually work.
6. **Test mode** adds a simulated jamming signature to real measurements, so you can demo the whole pipeline without any radio.

Never buy or switch on a jammer. It is illegal. JamMap only listens.
