# Custom alert assets

Put your own alert sound and image in this folder, then name them in `.env`:

```
ALERT_SOUND=cash-register.mp3
ALERT_IMAGE=party.gif
```

- Sound: `.mp3`, `.ogg`, `.wav` or `.m4a`. Leave `ALERT_SOUND` empty for the
  built-in chime, or set it to `none` for silence.
- Image: `.gif`, `.png`, `.webp`, `.jpg`, `.jpeg` or `.avif`, shown above the
  alert text. Animated GIFs and WebPs play as normal.
- Plain file names only, no sub-folders.
- The service checks both files at startup and refuses to start if one is
  missing, so a typo shows up immediately instead of mid-stream.

Only the two files named in `.env` are ever served, and only through the secret
overlay URL. Everything else in this folder stays private, and git ignores it.

## Soundboard

Viewers can pay to play a sound on stream. To turn it on, put the sound files
here and list them in `soundboard.json` in this folder:

```json
[
  { "id": "airhorn", "name": "Air horn", "price": "2.50", "file": "airhorn.mp3" },
  { "id": "bruh", "name": "Bruh", "price": 1, "file": "bruh.ogg" }
]
```

- `id`: letters, digits, dashes and underscores, up to 64, e.g. the file name
  without its extension. It appears in links and is saved with each purchase, so
  keep it once people have bought the sound.
- `name`: what viewers see, up to 40 characters.
- `price`: in `DONATION_CURRENCY`, between `DONATION_MIN_AMOUNT` and
  `DONATION_MAX_AMOUNT`. Viewers pay exactly this.
- `file`: a sound file in this folder (`.mp3`, `.ogg`, `.wav` or `.m4a`).
  Level the volume of your clips before adding them.
- Up to 50 sounds.

Listed sound files are public, so viewers can preview them before paying.
Without `soundboard.json` there is no soundboard. The service checks the file
at startup: if anything in it is wrong, the soundboard stays off (the rest of
the site runs as normal) and the log says what to fix, naming the sound. Check
with `docker compose logs crypto-dono | grep -i soundboard` after a restart.
