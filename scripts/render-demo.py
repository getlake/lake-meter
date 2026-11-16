#!/usr/bin/env python3
"""Render a short, premium lake-meter terminal demo (MP4 + GIF + poster)."""
from __future__ import annotations

import math
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "landing" / "assets"
FONT_MONO = "/usr/share/fonts/truetype/sand-box/google/Geist Mono/GeistMono-VariableFont_wght.ttf"
FONT_SANS = "/usr/share/fonts/truetype/sand-box/google/Inter/Inter-VariableFont_opsz,wght.ttf"

# Output size (1x). We render at 2x and downscale for sharpness.
W, H = 1280, 800
SCALE = 2
FPS = 20
DURATION = 24.0  # seconds

# Lake brand
PAPER = (243, 247, 237)       # --paper-2, matches lower hero
INK = (5, 47, 56)             # window
INK_BAR = (7, 63, 75)         # title bar
INK_2 = (23, 106, 115)
TEAL = (14, 124, 123)
TEAL_5 = (76, 183, 177)
TEAL_3 = (167, 219, 211)
TEXT = (227, 241, 239)
MUTED = (140, 180, 176)
DIM = (90, 130, 128)
SAND = (200, 163, 94)
CLAY = (178, 86, 63)
HAIKU = (110, 196, 154)
OPUS = (232, 196, 120)
WHITE = (251, 252, 248)
PROMPT = (76, 183, 177)
YES_BG = (14, 124, 123)
PANEL = (10, 58, 66)
CAP_BG = (36, 42, 36)
RECEIPT_BG = (8, 54, 62)


def font(path: str, size: float, weight: float | None = None) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(path, int(size * SCALE))
    try:
        axes = {a.name: a for a in f.get_variation()}  # type: ignore[attr-defined]
    except Exception:
        axes = {}
    try:
        if weight is not None and hasattr(f, "set_variation_by_axes"):
            # Inter has opsz,wght; Geist Mono has wght
            names = []
            try:
                names = [a.name for a in f.get_variation()]  # type: ignore[attr-defined]
            except Exception:
                pass
            if "opsz" in names and "wght" in names:
                f.set_variation_by_axes([size, weight])
            else:
                f.set_variation_by_axes([weight])
    except Exception:
        pass
    return f


def lerp(a, b, t):
    t = max(0.0, min(1.0, t))
    t = t * t * (3 - 2 * t)  # smoothstep
    if isinstance(a, tuple):
        return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))
    return a + (b - a) * t


def ease_out(t):
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
    return m


class Text:
    def __init__(self):
        self.mono = font(FONT_MONO, 15.5, 400)
        self.mono_sm = font(FONT_MONO, 13.5, 400)
        self.mono_md = font(FONT_MONO, 15.5, 500)
        self.mono_bd = font(FONT_MONO, 15.5, 600)
        self.sans = font(FONT_SANS, 13, 500)
        self.sans_sm = font(FONT_SANS, 11.5, 550)
        # measure cell width from a monospaced font
        self.cw = self.mono.getlength("M")
        self.ch = 26 * SCALE  # line height

    def draw(self, im, xy, s, fill, fnt=None, anchor="lt"):
        ImageDraw.Draw(im).text(xy, s, font=fnt or self.mono, fill=fill, anchor=anchor)


def type_count(text: str, t: float, start: float, cps: float = 18) -> int:
    if t < start:
        return 0
    return min(len(text), int((t - start) * cps))


def appear(t, start, dur=0.35):
    return ease_out((t - start) / dur) if t >= start else 0.0


def fade_color(bg, fg, a):
    if a <= 0:
        return bg
    if a >= 1:
        return fg
    return tuple(int(bg[i] + (fg[i] - bg[i]) * a) for i in range(3))


# --- content (real lake-meter plan output, plus a cap stop) ---
CMD = "lake-meter plan plan.md"
HEADER = "Lake Meter · plan breakdown"
SUB = "a model for every step"

ROWS = [
    # (num, step, filled_dots, model, model_color, tokens)
    ("1", "Add retry settings to config",        1, "Haiku 5.5",  HAIKU, "40k–161k"),
    ("2", "Design an idempotent delivery queue", 5, "Opus 5.5",   OPUS,  "1.5M–6.2M"),
    ("3", "Implement the retry worker",          4, "Opus 5.5",   OPUS,  "720k–2.6M"),
    ("4", "Expose delivery status in the API",   3, "Sonnet 5.5", TEAL_5,"284k–1.0M"),
    ("5", "Tests for failure paths",             3, "Sonnet 5.5", TEAL_5,"284k–1.0M"),
    ("6", "Update the changelog",                1, "Haiku 5.5",  HAIKU, "40k–161k"),
]

TOTAL_A = "A model per step"
TOTAL_B = "Haiku for the easy steps, Opus only where it's needed"

CAP_TITLE = "Run cap reached"
CAP_LINE1 = "Lake Meter: this run has used about $2.15  (cap $2.00)."
CAP_LINE2 = "Approve to continue with +$1.00 headroom, or deny to stop here."
RECEIPT = "Lake Meter · run $2.15 · 318k tok · Opus $2.08 · Haiku $0.07 · cap $2.00"
RECEIPT_SUB = "Stopped at the cap.  Measured from the session transcript."


def draw_window_chrome(base: Image.Image, T: Text, t: float):
    sw, sh = W * SCALE, H * SCALE
    pad = 40 * SCALE
    # soft shadow
    shadow = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    win = (pad, pad, sw - pad, sh - pad)
    radius = 18 * SCALE
    sd.rounded_rectangle(
        (win[0] + 10 * SCALE, win[1] + 18 * SCALE, win[2] + 10 * SCALE, win[3] + 18 * SCALE),
        radius=radius,
        fill=(7, 63, 75, 55),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=18 * SCALE))
    base.alpha_composite(shadow)

    # window body
    body = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
    bd = ImageDraw.Draw(body)
    bd.rounded_rectangle(win, radius=radius, fill=INK + (255,))
    # title bar
    bar_h = 44 * SCALE
    # clip title bar to rounded top: draw full then mask later isn't needed if we draw a rect under the top corners
    bd.rounded_rectangle((win[0], win[1], win[2], win[1] + bar_h + 18 * SCALE), radius=radius, fill=INK_BAR + (255,))
    bd.rectangle((win[0], win[1] + bar_h, win[2], win[1] + bar_h + 20 * SCALE), fill=INK + (255,))
    # hairline under title
    bd.line((win[0], win[1] + bar_h, win[2], win[1] + bar_h), fill=(14, 80, 84, 255), width=SCALE)

    # traffic lights
    dots = [(20, (214, 104, 96)), (40, (200, 163, 94)), (60, (76, 168, 130))]
    cy = win[1] + bar_h // 2
    for x, color in dots:
        cx = win[0] + x * SCALE
        r = int(6.2 * SCALE)
        bd.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color + (255,))

    T.draw(body, ((win[0] + win[2]) // 2, cy), "lake-meter", MUTED, T.sans, anchor="mm")
    # right side tag
    T.draw(body, (win[2] - 22 * SCALE, cy), "acme-api", DIM, T.sans_sm, anchor="rm")

    base.alpha_composite(body)
    # content origin
    return (win[0] + 28 * SCALE, win[1] + bar_h + 22 * SCALE, win[2] - 28 * SCALE, win[3] - 22 * SCALE)


def draw_prompt_line(im, T, origin, cmd_typed: str, t: float, show_cursor: bool):
    x, y = origin
    T.draw(im, (x, y), "$", PROMPT, T.mono_bd)
    gap = int(T.cw * 1.6)
    T.draw(im, (x + gap, y), cmd_typed, TEXT, T.mono)
    if show_cursor:
        cx = x + gap + T.mono.getlength(cmd_typed) + 2 * SCALE
        ch = int(18 * SCALE)
        ImageDraw.Draw(im).rectangle((cx, y + 3 * SCALE, cx + int(8 * SCALE), y + 3 * SCALE + ch), fill=TEAL_5)


def draw_complexity(im, T, xy, filled, alpha, bg):
    x, y = xy
    # five dots, filled then empty
    for i in range(5):
        ch = "●" if i < filled else "○"
        col = fade_color(bg, TEAL_5 if i < filled else DIM, alpha)
        T.draw(im, (x + i * T.cw, y), ch, col, T.mono)


def layout_cols(T, x0):
    # column x positions (generous gaps so headers never collide)
    c_num = x0
    c_step = x0 + int(T.cw * 3)
    c_cx = x0 + int(T.cw * 44)
    c_model = x0 + int(T.cw * 58)
    c_tok = x0 + int(T.cw * 72)
    return c_num, c_step, c_cx, c_model, c_tok


def draw_table(im, T, box, t, bg):
    x0, y0, x1, y1 = box
    # header
    a = appear(t, 3.55, 0.3)
    if a <= 0:
        return y0
    T.draw(im, (x0, y0), HEADER, fade_color(bg, WHITE, a), T.mono_bd)
    T.draw(im, (x0 + T.mono_bd.getlength(HEADER) + 18 * SCALE, y0), SUB, fade_color(bg, DIM, a * 0.9), T.mono_sm)

    y = y0 + int(T.ch * 1.55)
    a2 = appear(t, 3.9, 0.25)
    cols = layout_cols(T, x0)
    labels = [("#", cols[0]), ("Step", cols[1]), ("Complexity", cols[2]), ("Model", cols[3]), ("Tokens", cols[4])]
    for lab, cx in labels:
        T.draw(im, (cx, y), lab, fade_color(bg, MUTED, a2), T.mono_sm)
    # rule
    if a2 > 0:
        rule_y = y + int(18 * SCALE)
        ImageDraw.Draw(im).line(
            (x0, rule_y, x0 + int((x1 - x0) * a2), rule_y),
            fill=fade_color(bg, (20, 90, 94), a2),
            width=SCALE,
        )

    y = y0 + int(T.ch * 2.45)
    row_start = 4.25
    row_gap = 0.42
    for i, (num, step, dots, model, mcol, tokens) in enumerate(ROWS):
        a_r = appear(t, row_start + i * row_gap, 0.28)
        if a_r <= 0:
            continue
        # slight rise
        dy = int((1 - a_r) * 8 * SCALE)
        yy = y + i * T.ch + dy
        T.draw(im, (cols[0], yy), num, fade_color(bg, DIM, a_r), T.mono)
        T.draw(im, (cols[1], yy), step, fade_color(bg, TEXT, a_r), T.mono)
        draw_complexity(im, T, (cols[2], yy), dots, a_r, bg)
        T.draw(im, (cols[3], yy), model, fade_color(bg, mcol, a_r), T.mono_md)
        T.draw(im, (cols[4], yy), tokens, fade_color(bg, TEAL_3, a_r), T.mono_md)

    y_tot = y + len(ROWS) * T.ch + int(10 * SCALE)
    a_t = appear(t, row_start + 6 * row_gap + 0.15, 0.35)
    if a_t > 0:
        ImageDraw.Draw(im).line(
            (x0, y_tot - int(8 * SCALE), x0 + int((x1 - x0) * a_t), y_tot - int(8 * SCALE)),
            fill=fade_color(bg, (20, 90, 94), a_t),
            width=SCALE,
        )
        T.draw(im, (x0, y_tot), TOTAL_A, fade_color(bg, WHITE, a_t), T.mono_md)
        T.draw(im, (x0, y_tot + T.ch), TOTAL_B, fade_color(bg, MUTED, a_t), T.mono)
    return y_tot + 2 * T.ch


def draw_statusline(im, T, box, t, usd, cap=2.00):
    x0, y0, x1, y1 = box
    # pinned near the bottom of the window content
    y = y1 - int(8 * SCALE)
    pct = min(1.35, usd / cap)
    bar_w = int(160 * SCALE)
    bar_h = int(5 * SCALE)
    # text
    label = f"Lake  ·  run ${usd:.2f} / ${cap:.2f}  ·  session ${usd:.2f}  ·  5h  18%"
    color = CLAY if usd >= cap else (SAND if usd >= cap * 0.8 else TEAL_5)
    T.draw(im, (x0, y), label, color, T.mono_sm, anchor="ls")
    # bar to the right
    bx = x1 - bar_w
    by = y - bar_h
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((bx, by, bx + bar_w, by + bar_h), radius=bar_h // 2, fill=(20, 70, 74, 255))
    fill_w = int(bar_w * min(pct, 1.0))
    if usd >= cap:
        fill = CLAY
    elif usd >= cap * 0.8:
        fill = SAND
    else:
        fill = TEAL_5
    if fill_w > 0:
        d.rounded_rectangle((bx, by, bx + fill_w, by + bar_h), radius=bar_h // 2, fill=fill + (255,))


def draw_cap_panel(im, T, box, t, start, choose_no_at):
    a = appear(t, start, 0.4)
    if a <= 0:
        return
    x0, y0, x1, y1 = box
    # panel sits under the table
    pad_x, pad_y = 18 * SCALE, 16 * SCALE
    pw = x1 - x0
    ph = int(148 * SCALE)
    # rise
    dy = int((1 - a) * 14 * SCALE)
    x, y = x0, y0 + dy
    overlay = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    # panel background
    fill = (12, 44, 48, int(235 * a))
    d.rounded_rectangle((x, y, x + pw, y + ph), radius=12 * SCALE, fill=fill)
    # left accent
    d.rounded_rectangle((x, y, x + int(4 * SCALE), y + ph), radius=2 * SCALE, fill=CLAY + (int(255 * a),))
    im.alpha_composite(overlay)

    bg_panel = (12, 44, 48)
    T.draw(im, (x + pad_x, y + pad_y), CAP_TITLE, fade_color(bg_panel, CLAY if a > 0.6 else fade_color(bg_panel, CLAY, a), 1), T.mono_bd)
    T.draw(im, (x + pad_x, y + pad_y + int(T.ch * 1.15)), CAP_LINE1, fade_color(bg_panel, TEXT, a), T.mono)
    T.draw(im, (x + pad_x, y + pad_y + int(T.ch * 2.05)), CAP_LINE2, fade_color(bg_panel, MUTED, a), T.mono)

    # choices
    cy = y + pad_y + int(T.ch * 3.25)
    selected_no = t >= choose_no_at
    # Yes pill
    yes_a = a
    no_sel = appear(t, choose_no_at, 0.25)
    # labels
    yes_text = "  1. Yes   +$1.00 headroom  "
    no_text = "  2. No    stop here  "
    # draw option rows
    def chevron(xy, color):
        cx, cy0 = xy
        s = int(5 * SCALE)
        d = ImageDraw.Draw(im)
        d.polygon(
            [(cx, cy0 - s), (cx + int(7 * SCALE), cy0), (cx, cy0 + s)],
            fill=color,
        )

    yes_x = x + pad_x + int(T.cw * 2)
    if not selected_no:
        chevron((x + pad_x + int(2 * SCALE), cy + int(8 * SCALE)), fade_color(bg_panel, TEAL_5, yes_a))
        T.draw(im, (yes_x, cy), "1. Yes    +$1.00 headroom", fade_color(bg_panel, TEXT, yes_a), T.mono)
        T.draw(im, (yes_x, cy + T.ch), "2. No     stop here", fade_color(bg_panel, MUTED, yes_a), T.mono)
    else:
        T.draw(im, (yes_x, cy), "1. Yes    +$1.00 headroom", fade_color(bg_panel, DIM, a), T.mono)
        chevron((x + pad_x + int(2 * SCALE), cy + T.ch + int(8 * SCALE)), fade_color(bg_panel, CLAY, no_sel))
        T.draw(im, (yes_x, cy + T.ch), "2. No     stop here", fade_color(bg_panel, WHITE, no_sel), T.mono_md)


def draw_receipt(im, T, box, t, start):
    a = appear(t, start, 0.4)
    if a <= 0:
        return
    x0, y0, x1, _ = box
    dy = int((1 - a) * 12 * SCALE)
    y = y0 + dy
    T.draw(im, (x0, y), RECEIPT, fade_color(INK, TEAL_3, a), T.mono_md)
    T.draw(im, (x0, y + T.ch), RECEIPT_SUB, fade_color(INK, MUTED, a), T.mono)


def usd_at(t, run_start, cap_at, cap_usd=2.15):
    if t < run_start:
        return 0.0
    if t >= cap_at:
        return cap_usd
    u = (t - run_start) / (cap_at - run_start)
    # accelerate a little toward the end
    u = u ** 0.85
    return cap_usd * u


def render_frame(T, t: float) -> Image.Image:
    sw, sh = W * SCALE, H * SCALE
    im = Image.new("RGBA", (sw, sh), PAPER + (255,))
    content = draw_window_chrome(im, T, t)
    x0, y0, x1, y1 = content

    # blinking cursor
    blink = (int(t * 2) % 2 == 0)

    # Phase 1: type the command
    n = type_count(CMD, t, 0.7, cps=16)
    typed = CMD[:n]
    show_cmd_cursor = t < 3.4 and (t < 0.7 or n < len(CMD) or blink)
    # fade the command a bit once the table is up? keep it.
    draw_prompt_line(im, T, (x0, y0), typed, t, show_cmd_cursor and t >= 0.35)

    # Phase 2: table under the command
    table_box = (x0, y0 + int(T.ch * 1.55), x1, y1)
    table_bottom = y0
    if t >= 3.4:
        table_bottom = draw_table(im, T, table_box, t, INK)

    # Phase 3: statusline + climbing spend, then cap
    run_start = 11.4
    cap_at = 14.6
    choose_no = 17.2
    receipt_at = 18.4

    if t >= run_start:
        usd = usd_at(t, run_start, cap_at)
        a_run = appear(t, run_start, 0.3)
        y_run = table_bottom + int(10 * SCALE) if table_bottom else y0 + int(T.ch * 12)
        T.draw(im, (x0, y_run), "...  implementing the plan", fade_color(INK, DIM, a_run), T.mono_sm)
        if t < receipt_at:
            draw_statusline(im, T, content, t, usd)

    if t >= cap_at:
        # cap panel sits below the totals, with room for the receipt under it
        cap_y = (table_bottom + int(36 * SCALE)) if table_bottom else y0 + int(T.ch * 13)
        cap_y = min(cap_y, y1 - int(220 * SCALE))
        draw_cap_panel(im, T, (x0, cap_y, x1, y1), t, cap_at, choose_no)

    if t >= receipt_at:
        rec_y = y1 - int(44 * SCALE)
        draw_receipt(im, T, (x0, rec_y, x1, y1), t, receipt_at)

    # downscale with high-quality filter
    return im.resize((W, H), Image.Resampling.LANCZOS)


def encode(frames_dir: Path):
    mp4 = OUT / "demo.mp4"
    gif = OUT / "demo.gif"
    poster = OUT / "demo.jpg"
    palette = frames_dir / "palette.png"
    # MP4, crisp, small
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-framerate", str(FPS),
            "-i", str(frames_dir / "frame_%04d.png"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            "-crf", "18", "-preset", "slow",
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            str(mp4),
        ],
        check=True,
    )
    # palette-based GIF, reasonably small
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-framerate", str(FPS),
            "-i", str(frames_dir / "frame_%04d.png"),
            "-vf", "fps=16,scale=1080:-1:flags=lanczos,palettegen=stats_mode=diff:max_colors=96",
            str(palette),
        ],
        check=True,
    )
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-framerate", str(FPS),
            "-i", str(frames_dir / "frame_%04d.png"),
            "-i", str(palette),
            "-lavfi", "fps=16,scale=1080:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle",
            "-loop", "0",
            str(gif),
        ],
        check=True,
    )
    # poster from a mid-hold frame (table complete, just before the cap) ~ t=11.0 → frame 220
    # we'll just pick a later beautiful frame: after receipt, last frame also works; better a 'wow' frame with table+cap
    # Use a frame around t=19.6 (receipt just in)
    # The caller writes a dedicated poster from the best frame; fallback:
    last = sorted(frames_dir.glob("frame_*.png"))[-1]
    img = Image.open(last).convert("RGB")
    img.save(poster, "JPEG", quality=92, optimize=True, subsampling=1)
    return mp4, gif, poster


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    T = Text()
    nframes = int(DURATION * FPS)
    with tempfile.TemporaryDirectory(prefix="lake-demo-") as td:
        tdir = Path(td)
        poster_src = None
        for i in range(nframes):
            t = i / FPS
            frame = render_frame(T, t)
            path = tdir / f"frame_{i:04d}.png"
            frame.convert("RGB").save(path)
            # wow frame: cap visible, No selected, receipt arriving ~19.0s
            if abs(t - 19.0) < (0.5 / FPS):
                poster_src = frame.convert("RGB")
            if i % 40 == 0:
                print(f"  frame {i+1}/{nframes}  t={t:.2f}s")
        if poster_src is not None:
            poster_src.save(tdir / "poster_src.jpg", "JPEG", quality=95)
        print("encoding…")
        mp4, gif, poster = encode(tdir)
        if poster_src is not None:
            poster_src.save(poster, "JPEG", quality=92, optimize=True, subsampling=1)
    for p in (mp4, gif, poster):
        kb = p.stat().st_size / 1024
        print(f"  {p.name}: {kb:.0f} KB")
    print("done")


if __name__ == "__main__":
    main()
