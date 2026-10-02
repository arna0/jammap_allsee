# Submission checklist: Colosseum Crypto World's Fair

**Deadline:** 13 October 2026, 06:59 UTC. Target: submit on 12 October.
Requirements source: https://colosseum.com/hackathon (FAQ "What is the required information in the submission portal?").

Write the form answers yourself; judges read them as the team's own words. Use these questions to prepare.

| Form field | Prepare | Ask yourself |
|---|---|---|
| Name and short description | JamMap + one sentence | Would someone outside crypto understand it in five seconds? |
| Blockchains and tools | Solana, Anchor, Ed25519 program, SPL Token, USDC, x402, Android GNSS API | Which parts work in the demo, and which are planned? Be precise. |
| Team and experience | Every member needs a Colosseum account | Why you? What do you understand about this problem that others don't? |
| Location | Shymkent, Kazakhstan | |
| Logo | `web/logo.svg` (export to PNG if needed) | |
| GitHub repository | Public repo with daily commits | Does the history show the work happened during the hackathon? Can a judge run it in five minutes from the README? |
| Pitch video, 2–3 min | `docs/PITCH-VIDEO-SCRIPT.md` + the deck | Clear audio? Sources for numbers? Face visible? |
| Demo video, ≤3 min | `docs/DEMO-VIDEO-SCRIPT.md` | Does it show a real Solana Explorer transaction and the phone? |
| Go-to-market, validation, distribution | `docs/GTM-AND-VALIDATION.md` + interview log | How many companies said yes? How do you get the first 100 phones and the first paying customer? |
| Prior work | The idea and code started on 2 October 2026 | Any code written before the hackathon must be disclosed (none here). |

## Technical checks before submitting

- [ ] `anchor test` passes
- [ ] Program deployed to devnet; program ID in the README
- [ ] `npm test` passes in `server/`
- [ ] App built and run on at least one real phone
- [ ] No `.keys/`, `.env` or credentials in the repository (`git status`)
- [ ] README renders on GitHub, including the diagram

## Recommended

- [ ] One-minute weekly update videos in Arena (Colosseum recommends them)
- [ ] A post on X with the demo, tagging @colosseum and @SuperteamKZ
