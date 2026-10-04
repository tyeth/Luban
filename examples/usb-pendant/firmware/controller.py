"""Hardware-independent joystick state, usable on CircuitPython and CPython."""
SLOW_FEED = 60
MAX_FEED = 600


def normalize(raw, center=32768, minimum=0, maximum=65535, inverted=False):
    span = maximum - center if raw >= center else center - minimum
    if span <= 0:
        raise ValueError("Invalid joystick calibration")
    value = max(-1.0, min(1.0, (raw - center) / span))
    return -value if inverted else value


def deadzone(value, zone=0.12):
    if abs(value) <= zone:
        return 0.0
    return (1 if value > 0 else -1) * (abs(value) - zone) / (1 - zone)


class Controller:
    def __init__(self):
        self.mode = "feed"
        self.feed = SLOW_FEED
        self.neutral_required = True
        self.button_raw = False
        self.button_stable = False
        self.button_changed = 0

    def update(self, x, y, twist, button, held, stop, now, dt, link, armed=True):
        if button != self.button_raw:
            self.button_raw = button
            self.button_changed = now
        if now - self.button_changed >= 0.03 and self.button_stable != button:
            self.button_stable = button
            if button:
                self.mode = "z" if self.mode == "feed" else "feed"
                self.feed = SLOW_FEED
                self.neutral_required = True
        if stop or not link:
            self.feed = SLOW_FEED
            self.neutral_required = True
        if x == 0 and y == 0 and twist == 0 and not held and not stop:
            self.neutral_required = False
        ready = not self.neutral_required
        if ready and self.mode == "feed" and link:
            self.feed = max(SLOW_FEED, min(MAX_FEED, self.feed + twist * 300 * min(dt, 0.1)))
        moving = ready and held and link and armed and not stop
        return {"x": x if moving else 0.0, "y": y if moving else 0.0,
                "z": twist if moving and self.mode == "z" else 0.0,
                "feed": int(self.feed), "mode": self.mode, "ready": ready,
                "deadman": moving, "stop": bool(stop)}
