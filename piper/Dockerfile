# Optional text-to-speech service for crypto-dono, built from the upstream
# piper-tts package (https://github.com/OHF-Voice/piper1-gpl, GPL-3.0-or-later).
# Piper runs as its own container and is reached over HTTP, so it is not part of
# the MIT-licensed crypto-dono image.
FROM python:3.12-slim

RUN pip install --no-cache-dir "piper-tts[http]==1.8.0" \
  && useradd --create-home --uid 1000 piper \
  && mkdir /voices && chown piper:piper /voices

# Voices are downloaded on first start and kept in this volume. Check the chosen
# voice's MODEL_CARD for its licence: some are non-commercial only.
# https://huggingface.co/rhasspy/piper-voices
VOLUME ["/voices"]
ENV PIPER_VOICE=en_US-ljspeech-medium
USER piper
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/info', timeout=4)"

# download_voices skips voices that are already present, so restarts are fast.
CMD ["sh", "-c", "python3 -m piper.download_voices --data-dir /voices \"$PIPER_VOICE\" && exec python3 -m piper.http_server --host 0.0.0.0 --port 5000 --data-dir /voices -m \"$PIPER_VOICE\""]
