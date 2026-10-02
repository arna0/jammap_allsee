"""Build the silent pitch video from the deck slides.

    python docs/deck/build_pitch_video.py

Renders every slide in deck.json order to a 1920x1080 PNG with headless Chrome or Edge,
then joins them into docs/deck/out/pitch-video.mp4 with short crossfades, timed to
docs/PITCH-VIDEO-SCRIPT.md. Also writes pitch-video.srt with the narration, to use as a
teleprompter or as subtitles. Record your own voice over the video.

Needs: Python 3, Chrome or Edge, and `pip install imageio-ffmpeg` (bundles ffmpeg).
Edit slides/*.html (e.g. replace [Your name]) and run again.
"""

import json
import re
import shutil
import subprocess
from pathlib import Path

import imageio_ffmpeg

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
FADE = 0.5  # seconds of crossfade between slides

# Seconds on screen per slide; matches docs/PITCH-VIDEO-SCRIPT.md (total under 3:00).
DURATIONS = {
    "cover": 12, "problem": 20, "gap": 18, "insight": 22, "how": 24, "product": 18,
    "crypto": 14, "customers": 14, "landscape": 6, "traction": 16, "team": 13,
}

# Uploaded deck images -> local copies.
ASSETS = {
    "/_blob/1eeaa8c7c2f52ced25270d663b2b011e": "assets/map.jpg",
    "/_blob/3c4a6c202b04f3f6846a52e7dcfa4fd9": "assets/evidence.jpg",
}

PAGE = """<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=block">
<style>
  * {{ margin: 0; box-sizing: border-box; }}
  html, body {{ width: 1920px; height: 1080px; overflow: hidden; }}
  section {{ position: relative; width: 1920px; height: 1080px; overflow: hidden; }}
  ul {{ padding-left: 1.2em; }}
  table {{ border-collapse: collapse; width: 100%; }}
  th, td {{ text-align: left; padding: 0.35em 0.6em; border-bottom: 1px solid #D5D9DE; }}
  th {{ font-weight: 600; color: #4F5862; }}
  aside {{ display: none; }}
</style></head><body>{body}</body></html>"""


def find_browser():
    for p in [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]:
        if Path(p).exists():
            return p
    for name in ("google-chrome", "chromium", "chrome", "msedge"):
        if shutil.which(name):
            return shutil.which(name)
    raise SystemExit("Chrome or Edge not found")


def render(browser, slide_id):
    html = (HERE / "slides" / f"{slide_id}.html").read_text(encoding="utf-8")
    for blob, local in ASSETS.items():
        html = html.replace(blob, (HERE / local).as_uri())
    page = OUT / f"{slide_id}.html"
    page.write_text(PAGE.format(body=html), encoding="utf-8")
    png = OUT / f"{slide_id}.png"
    subprocess.run(
        [browser, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
         "--window-size=1920,1080", "--virtual-time-budget=8000", f"--screenshot={png}", page.as_uri()],
        check=True, capture_output=True,
    )
    return png


def notes(slide_id):
    html = (HERE / "slides" / f"{slide_id}.html").read_text(encoding="utf-8")
    m = re.search(r"<aside>(.*?)</aside>", html, re.S)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else ""


def srt_time(t):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def write_srt(order, path):
    cues, t = [], 0.0
    for sid in order:
        dur = DURATIONS[sid]
        sentences = [s for s in re.split(r"(?<=[.!?])\s+", notes(sid)) if s]
        total = sum(len(s) for s in sentences) or 1
        start = t
        for s in sentences:
            end = start + dur * len(s) / total
            cues.append((start, end, s))
            start = end
        t += dur - FADE
    with open(path, "w", encoding="utf-8") as f:
        for i, (a, b, text) in enumerate(cues, 1):
            f.write(f"{i}\n{srt_time(a)} --> {srt_time(b)}\n{text}\n\n")


def main():
    OUT.mkdir(exist_ok=True)
    order = json.loads((HERE / "deck.json").read_text(encoding="utf-8"))["order"]
    browser = find_browser()
    pngs = []
    for sid in order:
        print("render", sid)
        pngs.append(render(browser, sid))

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    args = [ffmpeg, "-y"]
    for sid, png in zip(order, pngs):
        args += ["-loop", "1", "-framerate", "30", "-t", str(DURATIONS[sid]), "-i", str(png)]
    total = sum(DURATIONS[s] for s in order) - FADE * (len(order) - 1)
    args += ["-f", "lavfi", "-t", f"{total:.2f}", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]

    chain, prev, offset = [], "[0:v]", 0.0
    for i in range(1, len(order)):
        offset += DURATIONS[order[i - 1]] - FADE
        label = f"[v{i}]"
        chain.append(f"{prev}[{i}:v]xfade=transition=fade:duration={FADE}:offset={offset:.2f}{label}")
        prev = label
    chain.append(f"{prev}format=yuv420p[vout]")
    mp4 = OUT / "pitch-video.mp4"
    args += ["-filter_complex", ";".join(chain), "-map", "[vout]", "-map", f"{len(order)}:a",
             "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-shortest", str(mp4)]
    print("encode", mp4.name)
    subprocess.run(args, check=True, capture_output=True)

    write_srt(order, OUT / "pitch-video.srt")
    print(f"done: {mp4} ({total:.0f} s) and pitch-video.srt")


if __name__ == "__main__":
    main()
