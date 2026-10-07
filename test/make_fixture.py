"""Erzeugt test/fixtures/ton_pause.wav: abwechselnd 1 s Ton und 1 s (fast) Stille."""
import math
import random
import struct
import wave
from pathlib import Path

# === EINSTELLUNGEN ===
OUTPUT_PATH = Path(__file__).parent / "fixtures" / "ton_pause.wav"
SAMPLE_RATE = 48000
DURATION_S = 8
SEGMENT_S = 1.0
TONE_HZ = 440
TONE_AMPLITUDE = 0.3
NOISE_AMPLITUDE = 0.0005
SEED = 42
# =====================


def main() -> None:
    random.seed(SEED)
    frames = bytearray()
    for i in range(SAMPLE_RATE * DURATION_S):
        t = i / SAMPLE_RATE
        tone = int(t / SEGMENT_S) % 2 == 0
        if tone:
            x = TONE_AMPLITUDE * math.sin(2 * math.pi * TONE_HZ * t)
        else:
            x = NOISE_AMPLITUDE * random.uniform(-1, 1)
        frames += struct.pack("<h", int(max(-1.0, min(1.0, x)) * 32767))

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUTPUT_PATH), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(bytes(frames))
    print(f"Gespeichert: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
