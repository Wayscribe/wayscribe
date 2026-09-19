"""Renders the demo narration (scripts/demo-narration.json) with Kokoro.

Run by scripts/demo-narrate.mjs with the Python from the Kokoro environment it
documents; not meant to be run by hand, though it can be:

  <tts>/.venv/bin/python scripts/demo-tts.py NARRATION_JSON OUT_DIR MODELS_DIR [--samples]

Writes one WAV per line (24 kHz mono, silence trimmed at both ends) and
durations.json, which the recording paces itself by. With --samples it writes
the sample sentence in each sample voice instead, for choosing a voice.
"""

import json
import os
import re
import sys

import numpy as np
import soundfile as sf
from kokoro_onnx import EspeakConfig, Kokoro

narration_path, out_dir, models_dir = sys.argv[1:4]
samples = "--samples" in sys.argv[4:]

with open(narration_path, encoding="utf-8") as handle:
    narration = json.load(handle)

# espeak-ng keeps its data path in a 160-byte buffer, and the copy bundled with
# kokoro-onnx sits deeper than that inside a scratch directory, so point at a
# system install (brew install espeak-ng) unless told otherwise.
espeak = EspeakConfig(
    lib_path=os.environ.get("ESPEAK_LIB", "/opt/homebrew/lib/libespeak-ng.dylib"),
    data_path=os.environ.get("ESPEAK_DATA", "/opt/homebrew/share/espeak-ng-data"),
)
kokoro = Kokoro(
    os.path.join(models_dir, "kokoro-v1.0.onnx"),
    os.path.join(models_dir, "voices-v1.0.bin"),
    espeak_config=espeak,
)

# Respellings for words espeak gets wrong, longest first so "wayscribe.dev"
# is replaced before "Wayscribe" can match inside it.
pronounce = narration.get("pronounce", {})
pattern = (
    re.compile("|".join(re.escape(key) for key in sorted(pronounce, key=len, reverse=True)))
    if pronounce
    else None
)


def spoken(text):
    return text if pattern is None else pattern.sub(lambda match: pronounce[match.group(0)], text)


def trim(samples_, rate, threshold=1e-3, pad=0.03):
    loud = np.flatnonzero(np.abs(samples_) > threshold)
    if loud.size == 0:
        return samples_
    margin = int(pad * rate)
    return samples_[max(0, loud[0] - margin) : loud[-1] + margin + 1]


def render(text, voice, path):
    audio, rate = kokoro.create(
        spoken(text), voice=voice, speed=narration.get("speed", 1.0), lang=narration.get("lang", "en-us")
    )
    audio = trim(np.asarray(audio, dtype=np.float32), rate)
    sf.write(path, audio, rate, subtype="PCM_16")
    return {
        "seconds": round(len(audio) / rate, 3),
        "peak": round(float(np.max(np.abs(audio))), 3),
        "phonemes": kokoro.tokenizer.phonemize(spoken(text), narration.get("lang", "en-us")),
    }


os.makedirs(out_dir, exist_ok=True)
if samples:
    for voice in narration["sample"]["voices"]:
        info = render(narration["sample"]["text"], voice, os.path.join(out_dir, f"sample-{voice}.wav"))
        print(f"  sample-{voice}.wav  {info['seconds']:.2f}s")
    sys.exit(0)

durations = []
for index, line in enumerate(narration["lines"]):
    name = f"{index + 1:02d}-{line['name']}.wav"
    info = render(line["text"], line.get("voice", narration["voice"]), os.path.join(out_dir, name))
    durations.append({"name": line["name"], "file": name, "text": line["text"], **info})
    print(f"  {info['seconds']:5.2f}s  {line['name']}")

with open(os.path.join(out_dir, "durations.json"), "w", encoding="utf-8") as handle:
    json.dump(durations, handle, indent=2)
    handle.write("\n")
