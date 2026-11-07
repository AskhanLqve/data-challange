#!/usr/bin/env python3
"""Распознавание речи для CQA (faster-whisper, локально).

    python asr.py <audio-file> [--model medium] [--lang auto|ru|kk|en] [--device auto|cuda|cpu]

Печатает JSON: {language, duration, channels, device, segments: [{start, end, text, channel}]}.
Стерео: каждый канал распознаётся отдельно (обычно это оператор и клиент) — роли можно поправить в интерфейсе.
Моно: один поток, роли назначаются эвристикой на сервере и правятся вручную.
"""
import argparse
import json
import sys

import numpy as np


def load_channels(path, sr=16000):
    """Декодирует файл в float32 16 кГц, отдельно по каналам (до двух)."""
    import av

    container = av.open(path)
    stream = container.streams.audio[0]
    n_ch = min(2, stream.channels or 1)
    layout = "stereo" if n_ch == 2 else "mono"
    resampler = av.AudioResampler(format="fltp", layout=layout, rate=sr)
    chunks = []
    for frame in container.decode(stream):
        for out in resampler.resample(frame):
            chunks.append(out.to_ndarray())
    for out in resampler.resample(None):
        chunks.append(out.to_ndarray())
    container.close()
    if not chunks:
        return [], 0.0
    data = np.concatenate(chunks, axis=1).astype(np.float32)
    channels = [data[i] for i in range(data.shape[0])]
    # если каналы практически одинаковые — это «псевдостерео», распознаём как моно
    if len(channels) == 2:
        a, b = channels
        if np.mean(np.abs(a - b)) < 0.02 * (np.mean(np.abs(a)) + 1e-9) or np.mean(np.abs(a - b)) < 1e-4:
            channels = [(a + b) / 2]
    return channels, data.shape[1] / sr


def make_model(name, device):
    from faster_whisper import WhisperModel

    tries = [("cuda", "int8_float16"), ("cpu", "int8")] if device == "auto" else [(device, "int8_float16" if device == "cuda" else "int8")]
    last = None
    for dev, ctype in tries:
        try:
            return WhisperModel(name, device=dev, compute_type=ctype), dev
        except Exception as e:  # нет CUDA / не хватает памяти — пробуем дальше
            last = e
    raise last


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--model", default="medium")
    ap.add_argument("--lang", default="auto")
    ap.add_argument("--device", default="auto")
    args = ap.parse_args()

    channels, duration = load_channels(args.file)
    if not channels:
        print(json.dumps({"error": "Пустой или неподдерживаемый аудиофайл"}, ensure_ascii=False))
        return 1
    model, device = make_model(args.model, args.device)
    lang = None if args.lang == "auto" else args.lang
    segments, detected = [], None
    for ch_idx, audio in enumerate(channels):
        try:
            segs, info = model.transcribe(audio, language=lang, vad_filter=True, beam_size=5, condition_on_previous_text=False)
        except RuntimeError as e:  # например, нехватка видеопамяти посреди работы — повтор на CPU
            if device != "cuda":
                raise
            model, device = make_model(args.model, "cpu")
            segs, info = model.transcribe(audio, language=lang, vad_filter=True, beam_size=5, condition_on_previous_text=False)
        detected = detected or info.language
        for s in segs:
            text = s.text.strip()
            if text:
                segments.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": text, "channel": ch_idx})
    segments.sort(key=lambda s: (s["start"], s["channel"]))
    print(json.dumps({"language": detected, "duration": round(duration, 2), "channels": len(channels), "device": device, "segments": segments}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
