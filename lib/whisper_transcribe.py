"""Transcribe one audio file on this machine and print the text.

Usage: <python-with-mlx_whisper> whisper_transcribe.py <audio-file>
Model: $COCKPIT_WHISPER_MODEL (default mlx-community/whisper-small.en-mlx). Needs ffmpeg on PATH.
Runs offline once the model is cached.
"""
import os
import sys

os.environ.setdefault("HF_HUB_OFFLINE", "1")

import mlx_whisper  # noqa: E402

MODEL = os.environ.get("COCKPIT_WHISPER_MODEL", "mlx-community/whisper-small.en-mlx")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: whisper_transcribe.py <audio-file>", file=sys.stderr)
        return 2
    result = mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo=MODEL, task="transcribe", verbose=None)
    print(str(result.get("text", "")).strip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
