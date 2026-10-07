"""Erzeugt die Test-WAVs: abwechselnd Ton (Sinus) und fast-Stille (leises Rauschen)."""
import math
import random
import struct
import wave
from pathlib import Path

# === EINSTELLUNGEN ===
OUTPUT_DIR = Path(__file__).parent / "fixtures"
SAMPLE_RATE = 48000
TONE_HZ = 440
TONE_AMPLITUDE = 0.3
NOISE_AMPLITUDE = 0.0005
SEED = 42
# Name → (Ton-Dauer s, Pausen-Dauer s, Anzahl Zyklen, Rauschen in der Pause)
FIXTURES = {
    "ton_pause.wav": (1.0, 1.0, 4, NOISE_AMPLITUDE),
    "ton_kurzpause.wav": (0.8, 0.35, 7, NOISE_AMPLITUDE),
    "ton_nullstille.wav": (1.0, 1.0, 4, 0.0),  # digitale Stille: exakt 0
}
# =====================


def render(tone_s: float, pause_s: float, cycles: int, noise: float) -> bytes:
    frames = bytearray()
    period = tone_s + pause_s
    for i in range(int(SAMPLE_RATE * period * cycles)):
        t = i / SAMPLE_RATE
        if (t % period) < tone_s:
            x = TONE_AMPLITUDE * math.sin(2 * math.pi * TONE_HZ * t)
        else:
            x = noise * random.uniform(-1, 1)
        frames += struct.pack("<h", int(max(-1.0, min(1.0, x)) * 32767))
    return bytes(frames)


def main() -> None:
    random.seed(SEED)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, (tone_s, pause_s, cycles, noise) in FIXTURES.items():
        path = OUTPUT_DIR / name
        with wave.open(str(path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SAMPLE_RATE)
            w.writeframes(render(tone_s, pause_s, cycles, noise))
        print(f"Gespeichert: {path}")


if __name__ == "__main__":
    main()
