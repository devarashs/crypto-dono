# Roadmap

Self-hosted crypto donations for a single streamer: a donation page, payments
through NOWPayments, and alerts rendered in OBS as a Browser Source.

Items are ordered by priority. Each is one shippable outcome and is ticked only
once it has been run and demonstrated, not merely written.

## Decisions

- **Stack:** TypeScript on Node 24, run directly through Node's built-in type
  stripping (no build step). Fastify for HTTP. SQLite through Node's built-in
  `node:sqlite`, so there is no native module and no database server to run.
- **Distribution:** one Docker image plus `docker-compose.yml`; all configuration
  through `.env`.
- **Single streamer.** Multi-tenant hosting is out of scope: holding funds for
  other people brings custody and money-transmission obligations.

## Assumptions

Each can be revisited; none is load-bearing enough to block work.

- Donors enter an amount in fiat (`DONATION_CURRENCY`, default `usd`) and pick the
  coin on NOWPayments' hosted checkout.
- `NOWPAYMENTS_SANDBOX=true` points everything at the NOWPayments sandbox.
- Licence is MIT.
- Not in v1: multiple streamers, payouts, fiat conversion display.

## Phase 0 — Foundations

- [x] 1. The service boots from `.env` and refuses to start, with a clear error, when
      configuration is missing or invalid. Docker image and compose file included.
- [x] 2. Donations are stored durably in SQLite, with migrations.

## Phase 1 — Money path

- [x] 3. A viewer can donate: the donation page creates a NOWPayments invoice and
      redirects to its checkout. Validated, minimum enforced, rate-limited.
      Note: per-coin minimums are enforced by NOWPayments' checkout, not by us; the
      donor picks the coin there. DONATION_MIN_AMOUNT is our own floor.
- [x] 4. A confirmed payment is recorded exactly once: the IPN webhook verifies the
      HMAC-SHA512 signature, updates status idempotently, and triggers an alert on the
      status chosen by `ALERT_ON_STATUS`. Signature scheme verified against a real
      IPN (production, $5 in USDT on BSC, 2026-10-11: three IPNs, all signatures
      matched the Node reference form, one alert). The sandbox was unavailable.

## Phase 2 — Alerts

- [x] 5. Spike: establish whether browser speech synthesis produces audio inside the
      OBS Browser Source. The outcome decides the design of item 8.
      Result (OBS 32.2.2, CEF Chrome 127, Windows, 2026-10-11): speechSynthesis works
      and lists the three Windows SAPI voices, but its audio goes straight to the OS
      output device. With "Control audio via OBS" ticked the speech disappears while
      Web Audio still plays, so browser speech can never be mixed or routed in OBS,
      and its voices depend on the streaming machine's OS.
- [ ] 6. Donations appear as alerts in OBS: token-protected overlay, Server-Sent
      Events, queued playback, missed alerts replayed after a reconnect.
      Status: built and demonstrated in Chromium and Docker (live alert from a signed
      IPN, unicode, HTML shown as text, ack after display, two missed alerts replayed
      in order, clean console). Not yet confirmed inside OBS itself.
- [ ] 7. The streamer can restyle alerts (sound, image, duration, template) without
      touching code.
- [ ] 8. Donation messages are read aloud (design per item 5).
      Decided 2026-10-11: server-side synthesis with Piper, so speech flows through
      the overlay's own audio and therefore through OBS's mixer. Piper runs as a
      separate, optional compose service reached over HTTP (TTS_URL): its engine is
      GPL-3 (piper1-gpl) and voices carry per-model licences, so it is not bundled
      into this MIT image. Check the chosen voice's model card licence. No TTS_URL
      means messages are shown but not spoken.
- [ ] 9. Messages are filtered: maximum length, banned words, minimum amounts to show
      a message and to read it aloud.

## Phase 3 — Admin

- [ ] 10. The streamer can manage alerts from a password-protected admin page:
      donation history, send a test alert, replay or skip.

## Phase 4 — Open-source release

- [ ] 11. Someone else can self-host it from the README alone: NOWPayments setup,
      deployment (VPS, PaaS, home PC behind a tunnel), OBS setup. Licence and CI.
