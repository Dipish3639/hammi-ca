"""Race page for the 128x64 Velora Matrix panel.

Shows Jakob's team in the Hammi 24 race at race.hammi.ca: his place, the top three, and the lap
as a small map of the circuit with a dot for every car (his car drawn bigger). Between races it shows the countdown
to the next start and how his team did last time.

Data comes from GET https://race.hammi.ca/api/race, polled in a background thread, so drawing
never waits on the network. Between polls the dots move on by each car's speed, so they glide.

Usable on its own:  feed = RaceFeed(); feed.start(); img = render(feed)  -> 128x64 PIL RGB image.
"""
import json
import threading
import time
import urllib.request

from PIL import Image, ImageDraw

RACE_URL = 'https://race.hammi.ca'
TEAM_NAME = 'Dipish'   # matched first (team name defaults to the Velora username)
TEAM_NUMBER = 7        # fallback if the team is renamed
POLL_SECONDS = 3
W, H = 128, 64

GOLD, SILVER, BRONZE = (255, 190, 40), (190, 200, 215), (205, 120, 50)
WHITE, GREY, DIM, RED, GREEN = (235, 235, 235), (120, 125, 135), (45, 48, 55), (230, 50, 40), (60, 200, 90)

# 3x5 pixel font, one string of 15 bits per glyph (5 rows of 3).
_F = {
    'A': '010101111101101', 'B': '110101110101110', 'C': '011100100100011', 'D': '110101101101110',
    'E': '111100110100111', 'F': '111100110100100', 'G': '011100101101011', 'H': '101101111101101',
    'I': '111010010010111', 'J': '001001001101010', 'K': '101101110101101', 'L': '100100100100111',
    'M': '101111111101101', 'N': '110101101101101', 'O': '010101101101010', 'P': '110101110100100',
    'Q': '010101101110011', 'R': '110101110101101', 'S': '011100010001110', 'T': '111010010010010',
    'U': '101101101101111', 'V': '101101101101010', 'W': '101101111111101', 'X': '101101010101101',
    'Y': '101101010010010', 'Z': '111001010100111',
    '0': '111101101101111', '1': '010110010010111', '2': '110001010100111', '3': '110001010001110',
    '4': '101101111001001', '5': '111100110001110', '6': '011100111101111', '7': '111001010010010',
    '8': '111101111101111', '9': '111101111001110',
    ' ': '000000000000000', '+': '000010111010000', '-': '000000111000000', ':': '000010000010000',
    '.': '000000000000010', '/': '001001010100100', '#': '101111101111101', '!': '010010010000010',
    '?': '110001010000010', "'": '010010000000000', '&': '010101010101011', '>': '100010001010100',
    '(': '010100100100010', ')': '010001001001010', '_': '000000000000111', ',': '000000000010100',
}


def text_width(s, scale=1):
    return max(0, len(s) * 4 * scale - scale)


def draw_text(d, x, y, s, color, scale=1, max_w=None):
    """Draw upper-cased text in the 3x5 font. Returns the x after the last glyph."""
    for ch in str(s).upper():
        if max_w is not None and x + 3 * scale > max_w:
            break
        bits = _F.get(ch, _F['?'] if ch.strip() else _F[' '])
        for i, b in enumerate(bits):
            if b == '1':
                px, py = x + (i % 3) * scale, y + (i // 3) * scale
                d.rectangle([px, py, px + scale - 1, py + scale - 1], fill=color)
        x += 4 * scale
    return x


def hex_rgb(h, fallback=WHITE):
    try:
        h = h.lstrip('#')
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    except Exception:
        return fallback


def scale_rgb(c, k):
    return tuple(min(255, int(v * k)) for v in c)


def visible(c):
    """Lift very dark team colours so they show on a black panel."""
    m = max(c)
    return scale_rgb(c, 140 / m) if 0 < m < 140 else (c if m else GREY)


PIT_STATES = ('pitlane', 'stopped', 'garage')
MAP = (61, 27, 124, 60)   # x0, y0, x1, y1 of the circuit map on the panel
TRACK = (70, 74, 84)


def fmt_gap(car):
    if car.get('pos') == 1:
        return 'LEAD'
    if car.get('gapLaps'):
        return '+%dL' % car['gapLaps']
    g = float(car.get('gap') or 0)
    return '+%d:%02d' % (g // 60, g % 60) if g >= 60 else '+%.1f' % g


def fmt_hms(sec):
    sec = max(0, int(sec))
    h, m, s = sec // 3600, sec // 60 % 60, sec % 60
    return '%d:%02d:%02d' % (h, m, s) if h else '%d:%02d' % (m, s)


def is_mine(car):
    if car.get('bot'):
        return False
    return str(car.get('name', '')).lower() == TEAM_NAME.lower() or car.get('number') == TEAM_NUMBER


class RaceFeed:
    """Polls the race server in the background and keeps the last good answer."""

    def __init__(self, base=RACE_URL, poll=POLL_SECONDS):
        self.base, self.poll = base.rstrip('/'), poll
        self.data = None          # last /api/race answer
        self.fetched = 0.0        # time.monotonic() of that answer
        self.offset = 0.0         # server ms clock minus local ms clock
        self.length = 6200.0      # lap length in metres, from /api/track
        self.step = 10.0          # metres between track points
        self.points = None        # circuit outline [[x, y], ...] on the server's 1000x640 sheet
        self.error = None
        self._lock = threading.Lock()
        self._thread = None

    def _get(self, path):
        req = urllib.request.Request(self.base + path, headers={'User-Agent': 'velora-matrix-display/1.0'})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode('utf-8'))

    def fetch_once(self):
        try:
            if not self.points:
                t = self._get('/api/track')
                self.length = float(t.get('length') or 6200)
                self.step = float(t.get('step') or 10)
                self.points = t.get('points') or None
            d = self._get('/api/race')
            with self._lock:
                self.data, self.fetched, self.error = d, time.monotonic(), None
                if d.get('now'):
                    self.offset = d['now'] - time.time() * 1000
        except Exception as e:  # keep showing the last good data
            self.error = str(e)[:60]

    def _run(self):
        while True:
            self.fetch_once()
            time.sleep(self.poll)

    def start(self):
        if not self._thread:
            self._thread = threading.Thread(target=self._run, name='race-feed', daemon=True)
            self._thread.start()
        return self

    def snapshot(self):
        with self._lock:
            return self.data, time.monotonic() - self.fetched


def _render_race(d, img, race, age, length, step, points):
    cars = race.get('cars') or []
    mine = next((c for c in cars if is_mine(c)), None)
    n = len(cars)

    # --- top: my place ---------------------------------------------------------
    if mine:
        col = visible(hex_rgb(mine.get('color')))
        place = 'P%d' % mine['pos']
        pcol = GOLD if mine['pos'] == 1 else SILVER if mine['pos'] == 2 else BRONZE if mine['pos'] == 3 else WHITE
        x = draw_text(d, 1, 1, place, pcol, scale=3)
        x = max(x + 2, 38)
        draw_text(d, x, 1, mine.get('name', TEAM_NAME), col, max_w=W - 1)
        state = mine.get('state')
        if state == 'retired':
            line2, c2 = 'RETIRED', RED
        elif state == 'finished':
            line2, c2 = 'FINISHED', GREEN
        elif state in PIT_STATES:
            line2, c2 = 'IN THE PITS', GOLD
        else:
            line2, c2 = 'LAP %d  %s' % (mine.get('lap', 0), fmt_gap(mine)), WHITE
        draw_text(d, x, 8, line2, c2, max_w=W - 1)
    else:
        draw_text(d, 1, 1, 'HAMMI 24', WHITE, scale=2)
        draw_text(d, 1, 13, '%s NOT IN THIS RACE' % TEAM_NAME, GREY, max_w=W - 1)

    left = (race.get('duration') or 0) - (race.get('t') or 0)
    if mine:   # field size and time left under the name block
        draw_text(d, x, 15, 'OF %d  %s LEFT' % (n, fmt_hms(left)), GREY, max_w=W - 1)

    # flag colour strip under the header: yellow under full course yellow, blue in the rain
    strip = GOLD if race.get('fcy') else (60, 110, 200) if (race.get('rain') or 0) > 0.2 else DIM
    d.line([0, 22, W - 1, 22], fill=scale_rgb(strip, 0.6))

    # --- top three, left column --------------------------------------------------
    medal = [GOLD, SILVER, BRONZE]
    rows = [(i + 1, c, medal[i]) for i, c in enumerate(cars[:3])]
    if mine and mine['pos'] > 3:
        rows.append((mine['pos'], mine, WHITE))
    for k, (pos, c, pcol) in enumerate(rows):
        y = 26 + k * 9 + (3 if k == 3 else 0)
        me = is_mine(c)
        col = visible(hex_rgb(c.get('color')))
        x = draw_text(d, 1, y, str(pos), pcol)
        d.rectangle([x, y, x + 2, y + 4], fill=col)
        nx = draw_text(d, x + 4, y, c.get('name', '?'), WHITE if me else scale_rgb(WHITE, 0.75), max_w=MAP[0] - 3)
        if me:   # underline my team in its colour
            d.line([x + 4, y + 6, nx - 2, y + 6], fill=col)

    # --- circuit map, right side ------------------------------------------------------
    extra = min(age, POLL_SECONDS * 2)
    to_xy = _track_mapper(points, step, length)
    if points:
        outline = [to_xy(i * step) for i in range(0, len(points), 2)]
        d.line(outline + [outline[0]], fill=TRACK)
    else:   # no track shape yet: plain line
        d.line([MAP[0], (MAP[1] + MAP[3]) // 2, MAP[2], (MAP[1] + MAP[3]) // 2], fill=TRACK)
    sx, sy = to_xy(0)
    d.rectangle([sx, sy - 1, sx, sy + 1], fill=WHITE)          # start / finish

    def where(c):
        s = float(c.get('s') or 0)
        if c.get('state') not in ('retired', 'finished'):
            s += float(c.get('v') or 0) * extra
        return to_xy(s)

    for c in reversed(cars):          # leaders drawn last so they sit on top
        if is_mine(c) or c.get('state') == 'retired':
            continue
        x, y = where(c)
        col = scale_rgb(visible(hex_rgb(c.get('color'))), 0.8)
        if c.get('state') in PIT_STATES:
            col = scale_rgb(col, 0.5)
        d.rectangle([x, y, x + 1, y + 1], fill=col)
    if mine and mine.get('state') != 'retired':
        x, y = where(mine)
        d.rectangle([x - 3, y - 3, x + 3, y + 3], fill=WHITE)
        d.rectangle([x - 2, y - 2, x + 2, y + 2], fill=visible(hex_rgb(mine.get('color'))))


_map_cache = {}


def _track_mapper(points, step, length):
    """Function: metres into the lap -> (x, y) panel pixel inside MAP, keeping the track's shape."""
    key = (id(points), step, length)
    if key in _map_cache:
        return _map_cache[key]
    x0, y0, x1, y1 = MAP
    if points:
        xs, ys = [p[0] for p in points], [p[1] for p in points]
        bx, by = min(xs), min(ys)
        k = min((x1 - x0) / ((max(xs) - bx) or 1), (y1 - y0) / ((max(ys) - by) or 1))
        ox = x0 + ((x1 - x0) - (max(xs) - bx) * k) / 2
        oy = y0 + ((y1 - y0) - (max(ys) - by) * k) / 2
        n = len(points)

        def f(s):
            t = (s % length) / step
            i = int(t) % n
            j, u = (i + 1) % n, t - int(t)
            px = points[i][0] + (points[j][0] - points[i][0]) * u
            py = points[i][1] + (points[j][1] - points[i][1]) * u
            return int(round(ox + (px - bx) * k)), int(round(oy + (py - by) * k))
    else:
        def f(s):
            return x0 + int(round((s % length) / length * (x1 - x0))), (y0 + y1) // 2
    _map_cache.clear()
    _map_cache[key] = f
    return f


def _render_break(d, data, offset):
    draw_text(d, 1, 1, 'HAMMI 24', WHITE, scale=2)
    now_ms = time.time() * 1000 + offset
    ns = data.get('nextStart')
    draw_text(d, 1, 15, 'NEXT RACE IN', GREY)
    cd = fmt_hms((ns - now_ms) / 1000) if ns else '--:--'
    draw_text(d, 1, 22, cd, GOLD, scale=2)
    entered = any(str(t.get('name', '')).lower() == TEAM_NAME.lower() or t.get('number') == TEAM_NUMBER
                  for t in data.get('entries') or [])
    draw_text(d, 1, 36, '%s %s' % (TEAM_NAME, 'ENTERED' if entered else 'NOT ENTERED'),
              GREEN if entered else RED, max_w=W - 1)
    last = data.get('last') or {}
    res = last.get('results') or []
    mine = next((r for r in res if is_mine(r)), None)
    if mine:
        draw_text(d, 1, 46, 'LAST RACE P%d OF %d' % (mine['pos'], len(res)), WHITE, max_w=W - 1)
    if res:
        draw_text(d, 1, 54, 'WON BY %s' % res[0].get('name', '?'), GREY, max_w=W - 1)


def render(feed):
    img = Image.new('RGB', (W, H))
    d = ImageDraw.Draw(img)
    data, age = feed.snapshot()
    if data is None:
        draw_text(d, 1, 1, 'HAMMI 24', WHITE, scale=2)
        draw_text(d, 1, 20, 'LOADING RACE...' if not feed.error else 'RACE OFFLINE', GREY)
        return img
    race = data.get('race')
    if data.get('phase') == 'race' and race:
        _render_race(d, img, race, age, feed.length, feed.step, feed.points)
    else:
        _render_break(d, data, feed.offset)
    if feed.error:                     # small red dot: last fetch failed, showing older data
        d.point([W - 1, H - 1], fill=RED)
    return img
