# crypto-dono

Self-hosted crypto donations for live streams. Viewers donate on your own page,
pay in the coin of their choice through [NOWPayments](https://nowpayments.io),
and the donation pops up on stream as an alert in OBS. Optionally it is read
aloud.

One streamer, one small service, configured entirely through a `.env` file.

- **Donation page**: name, amount and message, then NOWPayments' hosted checkout.
- **OBS alerts**: a transparent Browser Source with a queue, a chime or your own
  sound, your own image and wording, and replay of alerts missed while OBS was
  closed.
- **Text-to-speech** (optional): messages read aloud by [Piper](https://github.com/OHF-Voice/piper1-gpl),
  played through OBS's own mixer.
- **Message filtering**: banned words, a length limit, and minimum amounts to
  show a message or read it aloud.
- **Admin page**: donation history, replay or skip alerts, send test alerts.

## How it works

```
Viewer ──► your donation page ──► NOWPayments checkout ──► viewer pays
                                          │
                                          ▼ signed payment webhook
                                   crypto-dono ── stores the donation
                                          │
                                          ▼ Server-Sent Events
                          OBS Browser Source (/overlay/<token>)
```

Each payment webhook is checked against your IPN secret before anything is
trusted, recorded exactly once however often NOWPayments retries it, and turned
into an alert when the payment reaches the status you choose.

## What you need

- A [NOWPayments](https://nowpayments.io) account, with
  - a **payout wallet** set up (where your money goes),
  - an **API key** (dashboard: payment settings, API keys),
  - an **IPN secret** (dashboard: payment settings, Instant payment
    notifications). NOWPayments only shows it in full once, so save it.
- **Docker** (recommended), or **Node.js 24** or newer.
- A **public HTTPS address** for the service. NOWPayments has to reach it to
  report payments. See [Deploying](#deploying) for three ways to get one.
- **OBS Studio**.

## Quick start

```bash
git clone <this repository> crypto-dono
cd crypto-dono
cp .env.example .env
```

Fill in `.env`. The required settings are:

| Setting | What to put |
| --- | --- |
| `PUBLIC_BASE_URL` | Your public address, e.g. `https://dono.example.com` |
| `NOWPAYMENTS_API_KEY` | From the NOWPayments dashboard |
| `NOWPAYMENTS_IPN_SECRET` | From the NOWPayments dashboard |
| `OVERLAY_TOKEN` | A long random string, see below |

Generate the overlay token with:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Then start it:

```bash
docker compose up -d --build
```

If anything in `.env` is missing or wrong, the service refuses to start and
lists every problem at once. Check with `docker compose logs`.

Every setting, with its default, is described in [.env.example](.env.example).

### Without Docker

```bash
npm ci
npm start
```

`npm start` reads `.env` itself. Node 24 runs the TypeScript sources directly;
there is no build step.

## Setting up OBS

1. Add a **Browser** source.
2. URL: `http://localhost:3000/overlay/<OVERLAY_TOKEN>`, if OBS runs on the same
   machine as the service. Otherwise use `PUBLIC_BASE_URL` in place of
   `http://localhost:3000`.
3. Width 1920, height 1080. Leave **Local file** unticked.
4. Tick **Control audio via OBS**, so alert sounds and speech go through OBS's
   mixer and onto your stream.
5. To hear alerts yourself as well, open **Edit → Advanced Audio Properties**
   and set the source's **Audio Monitoring** to **Monitor and Output**. Without
   this, alerts reach your viewers but not your headphones.

Send a test alert from `http://localhost:3000/overlay/<OVERLAY_TOKEN>/test`. The
page tells you how many overlays received it; "no overlay is connected" means
OBS is not loading the overlay URL.

**Keep the overlay URL private.** It contains the token, and anyone with it can
watch your alert feed or send test alerts. Do not show it on stream.

## Customising alerts

Put your own files in the `custom/` folder and name them in `.env`:

```
ALERT_SOUND=cash-register.mp3
ALERT_IMAGE=party.gif
ALERT_DURATION_SECONDS=10
ALERT_TEXT_TEMPLATE={name} just sent {amount}!
```

See [custom/README.md](custom/README.md) for the supported formats. Apply
changes with `docker compose up -d` (a plain `docker compose restart` does not
re-read `.env`), or restart `npm start`. Then refresh the Browser Source in OBS
(right-click, **Refresh**).

## Text-to-speech

Alerts can be read aloud by Piper, which runs as a separate, optional container:

```bash
docker compose --profile tts up -d --build
```

and in `.env`:

```
TTS_URL=http://piper:5000
```

The first start downloads the voice (about 60 MB). The default voice,
`en_US-ljspeech-medium`, is trained on public-domain recordings. To use another
voice set `PIPER_VOICE`, but **read the voice's MODEL_CARD first**: many Piper
voices are licensed for non-commercial use only, which may rule them out for a
monetised stream. Voices: <https://huggingface.co/rhasspy/piper-voices>.

If Piper is down, alerts still show, just without speech.

With `npm start` instead of Docker, run Piper on its own and point `TTS_URL` at
it:

```bash
docker build -t crypto-dono-piper ./piper
docker run -d -p 5000:5000 -v piper-voices:/voices crypto-dono-piper
```

```
TTS_URL=http://localhost:5000
```

## Filtering messages

```
BANNED_WORDS=badword,another bad phrase
MESSAGE_MAX_LENGTH=200
MESSAGE_MIN_AMOUNT=3
TTS_MIN_AMOUNT=5
```

Banned words are shown as stars and skipped when read aloud. They match whole
words, ignoring case. They catch plain use, not deliberate misspellings.
Filters apply when an alert is shown, so the original message stays in your
history and changing a filter affects every alert shown afterwards.

## Admin page

Set `ADMIN_PASSWORD` (12 characters or more) and open `/admin`. It shows your
donation history with the original messages, your overlay and test-alert links,
and lets you **replay** an alert or **skip** one. Skipping also removes it from
an overlay that is showing it right now.

The admin page is disabled when `ADMIN_PASSWORD` is empty. Restarting the service
signs you out.

## Choosing when alerts fire

`ALERT_ON_STATUS` sets how far a payment must get before its alert shows:

| Value | Alerts when | Trade-off |
| --- | --- | --- |
| `confirming` | the payment is seen on the blockchain | fastest, but could alert for a payment that never confirms |
| `confirmed` (default) | the blockchain has confirmed it | the money is real; under a minute on fast coins |
| `finished` | the money has reached your wallet | slowest |

NOWPayments does not always report every step: a payment can go straight from
`waiting` to `sending`. The service compares how far a payment has got rather
than waiting for one exact status, so an alert still fires.

Slow coins such as BTC can take 10 to 60 minutes to confirm. Coins like LTC,
TRX, SOL or USDT on TRC20 or BSC confirm much faster, and their minimum payment
is usually lower too. NOWPayments sets a minimum per coin and its checkout
enforces it; `DONATION_MIN_AMOUNT` is your own floor on top of that.

## Deploying

The service needs a public HTTPS address for payment webhooks, and must be
running to receive them. Donations made while it is down are still paid to you.
NOWPayments retries a webhook that fails (how often is set in its dashboard,
under Instant payment notifications), and you can resend one by hand from the
dashboard, so an alert can still arrive once the service is back.

**Run it behind a reverse proxy or tunnel, never with its port open directly to
the internet.** The service trusts the `X-Forwarded-For` and `X-Forwarded-Proto`
headers that a proxy sets. Exposed directly, a visitor could forge them to get
around the rate limits.

### Your streaming PC, with a Cloudflare Tunnel

Free, and nothing to host. Donations only work while your PC is on.

For a quick test, run a temporary tunnel and use the address it prints as
`PUBLIC_BASE_URL`:

```bash
cloudflared tunnel --url http://localhost:3000
```

The address changes on every restart, and invoices created under an old
address send their webhooks to a dead URL. For real streams, set up a
[named tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
on a domain you own, for a permanent address such as `https://dono.example.com`.

### A small VPS

Always on, so donations are recorded even while you are offline, and missed
alerts replay when OBS connects. [deploy/README.md](deploy/README.md) is a
step-by-step guide (tested on a $5 AWS Lightsail instance): Caddy for automatic
HTTPS, a swap file so 512 MB is enough, and a nightly database backup.

### A platform (Railway, Fly.io, Render, ...)

Deploy the `Dockerfile`, set the variables from `.env.example` in the platform's
settings, and attach a **persistent volume at `/app/data`**. Without it, your
donation history is lost on every deploy.

## Backups

Everything lives in the data volume: the SQLite database and the admin session
key. Copy it out with:

```bash
docker compose cp crypto-dono:/app/data ./backup
```

## Development

```bash
npm ci
npm test           # unit and integration tests
npm run typecheck
npm run dev        # restarts on file changes
```

Node 24 or newer. TypeScript runs directly through Node's type stripping, so
the sources stick to syntax that can be erased (no enums or namespaces).
SQLite comes from Node's built-in `node:sqlite`. [ROADMAP.md](ROADMAP.md) records
what was built, in what order, and the decisions behind it.

## Licence

MIT, see [LICENSE](LICENSE).

The optional Piper text-to-speech service is a separate program, licensed
GPL-3.0-or-later, built from its upstream package in its own container. It is
not part of this project's code or image. Piper voices carry their own licences.

This project is not affiliated with NOWPayments, OBS or Piper.
