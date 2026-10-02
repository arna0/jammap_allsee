# Pitch video script (2–3 minutes)

Judges watch this first. Record your face plus the slides (deck: https://claude.ai/artifact/WP6sYE6wS667MmrC35LDj9; export it as PDF or PPTX from Share › Export). The narration below is also in each slide's speaker notes. Rehearse it until you can say it in your own words, and replace every `[placeholder]` with real facts.

Judging criteria: founder–market fit, insight, product and execution, market size, communication, viability, traction.

| Slide | Time | Narration |
|---|---|---|
| 1 Cover | 0:00–0:12 | Hi, I'm [name] from Shymkent, Kazakhstan. This is JamMap. We use ordinary Android phones to detect when GPS is being jammed or faked, confirm each incident on Solana once several phones agree, and sell that map to drone and fleet software. |
| 2 Problem | 0:12–0:32 | GPS jamming and spoofing are no longer rare. According to IATA, spoofing grew 193 percent and jamming 67 percent between 2023 and 2025. At the 2024 peak, spoofing hit up to 1,500 flights a day. Jamming blocks the signal. Spoofing is worse: it feeds the receiver a fake position, and the device believes it. |
| 3 Gap | 0:32–0:50 | Existing interference maps come from aircraft, so they only cover airways. On the ground, where drones, trucks and tractors operate, nobody is measuring. A farm drone or a delivery fleet has no warning until something goes wrong. |
| 4 Insight | 0:50–1:12 | Billions of Android phones already contain a GPS receiver, and Android lets apps read raw satellite data. Two numbers matter: signal-to-noise and the receiver's gain. When someone jams, both drop. When a phone is just in a pocket, the signal drops but the gain goes up. That difference is how we avoid false alarms. |
| 5 How it works | 1:12–1:38 | The phone checks the signal every second. When it sees an attack, it signs a short report with its own key; it needs no wallet. A Solana program checks that signature itself, so even we can't fake a report, and confirms an incident only when three different phones agree. Drone and fleet software then buys the data for one cent per request in USDC. The app only listens; it never transmits. |
| 6 Product | 1:38–1:58 | This is running today: a live map of confirmed zones, the evidence behind each incident, where every phone sits in the jamming corner, and a route check a drone can run before a flight. All of it was built during this hackathon. |
| 7 Why Solana | 1:58–2:12 | Solana gives us records nobody can edit, which matters for insurers; token rewards that grow coverage where the problem is; and machine payments with fees far below a cent. |
| 8 Customers | 2:12–2:26 | Drone operators, precision farming, fleet tracking and insurers pay per request or per month, and part of the revenue goes back to the phones. |
| 10 Traction | 2:26–2:42 | So far: [N phones, N hours, N interviews, best quote]. Next: device attestation against fake phones, 100 phones in Shymkent and Almaty, and a paid pilot with a drone operator. |
| 11 Team | 2:42–2:55 | I'm [name], [one line about you and why you care]. JamMap: know where GPS can't be trusted. Thank you. |

Slide 9 (competition) can be shown silently during slide 8 if time is short.

## Silent slide video

`python docs/deck/build_pitch_video.py` renders the slides in `docs/deck/slides/` into `docs/deck/out/pitch-video.mp4` (2:52, slides timed to this script) and `pitch-video.srt` (the narration, timed). Record your voice over the video, for example in CapCut or Clipchamp: import the MP4, add a voice-over track, and use the SRT as a teleprompter or as subtitles. After editing a slide (e.g. replacing `[Your name]`), run the script again.

## Recording checklist

- Quiet room, wired or phone earbuds microphone
- Face visible in a corner, slides full screen
- Under 3:00 total; cut anything you stumble on
- Real numbers only on slide 10; leave a line out rather than invent one
