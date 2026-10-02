# Product demo video script (3 minutes max)

Screen recording (OBS or Windows Game Bar, Win+G) with voice-over. Show the product, not slides.

## Before recording

1. Deploy to devnet (docs/SETUP.md, step 3) so the feed shows real Solana transactions instead of "local".
2. Start the relayer: `npm run demo`. Reset state: `curl -X POST http://localhost:8787/v1/admin/reset`. Start the simulator: `npm run sim`.
3. Zoom the browser to 125% so text is readable.
4. Have the Android app open on a phone mirrored to the laptop (Android Studio's Running Devices window or scrcpy).

## Shots and narration

| Time | On screen | Narration |
|---|---|---|
| 0:00–0:15 | Dashboard, live | JamMap detects GPS jamming and spoofing with ordinary phones and records confirmed incidents on Solana. Here's how it works end to end. |
| 0:15–0:40 | Phone: status "No interference", live chart of signal-to-noise and gain | The app reads raw satellite measurements every second. The teal line is signal-to-noise; the amber line is the receiver's gain compared with its baseline. |
| 0:40–1:00 | Put the phone in a metal tin or wrap it in foil: status "Signal blocked, not reported" | If I block the signal, signal-to-noise drops, but the gain goes up. The app knows this is not an attack and sends nothing. That's how we avoid false alarms from pockets and tunnels. |
| 1:00–1:25 | Turn on Test mode: status "Jamming detected", log shows "Accepted · 1 of 3 phones" | Real jammers are illegal, so test mode adds a simulated jamming signature. Now both values drop. The phone signs a report with its own key and sends it. One phone is not enough to confirm anything. |
| 1:25–1:55 | Dashboard with simulator running: dashed zone turns solid red, status "Confirmed". Open the incident, show the evidence chart, click a transaction link to Solana Explorer | When a third phone in the same area agrees, the Solana program confirms the incident. Each point here is one phone, and all of them sit in the jamming corner. Every report is a Solana transaction, and the program checked each phone's signature itself. A single dishonest phone, like this one far away, stays unconfirmed. |
| 1:55–2:30 | Route check tab: click A and B across the red zone, press "Check route · $0.01", show "High risk" and the affected kilometres | A drone operator checks a route before a flight. The API asks for one cent in USDC through x402, the client pays, and gets the risk and exactly which part of the route crosses interference. No account and no API key. |
| 2:30–2:55 | Code: `programs/jammap/src/lib.rs` (signature check, quorum), then README | Built during the hackathon: the Anchor program with signature checks and quorum, the relayer and paid API, the Android app, the dashboard, and a simulator with tests. |
