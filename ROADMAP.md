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
- [x] 6. Donations appear as alerts in OBS: token-protected overlay, Server-Sent
      Events, queued playback, missed alerts replayed after a reconnect.
      Verified in Chromium and Docker, then in OBS 32.2.2 by the streamer
      (2026-10-11): the alert card shows, and with "Control audio via OBS" ticked the
      chime registers on the source's mixer meter. OBS does not monitor such a source
      by default, so the streamer only hears it after setting Audio Monitoring to
      "Monitor and Output"; that belongs in the README.
- [x] 6a. The streamer can send a test alert to OBS without a payment. Pulled
      forward from item 10 at the streamer's request (2026-10-11), to set up the
      overlay in OBS before the admin page exists. Protected by the overlay token.
- [x] 7. The streamer can restyle alerts (sound, image, duration, template) without
      touching code. Verified in Chromium (custom WAV, PNG, wording, 6 s duration) and
      in Docker through the read-only ./custom mount.
- [ ] 8. Donation messages are read aloud (design per item 5).
      Decided 2026-10-11: server-side synthesis with Piper, so speech flows through
      the overlay's own audio and therefore through OBS's mixer. Piper runs as a
      separate, optional compose service reached over HTTP (TTS_URL): its engine is
      GPL-3 (piper1-gpl) and voices carry per-model licences, so it is not bundled
      into this MIT image. Check the chosen voice's model card licence. No TTS_URL
      means messages are shown but not spoken.
      Status: built; verified in Chromium against a real Piper 1.8 container (speech
      ready before the card, 6.2 s clip played to its end, card held until then; with
      Piper stopped the alert still showed silently). Not yet heard inside OBS.
- [x] 9. Messages are filtered: maximum length, banned words, minimum amounts to show
      a message and to read it aloud. Applied at display time on every path (live,
      replay, test, speech after restart); verified end to end and in Chromium.

## Phase 3 — Admin

- [x] 10. The streamer can manage alerts from a password-protected admin page:
      donation history, replay or skip. (Test alerts moved to item 6a.)
      Verified in Chromium (sign-in, history, skipping an alert on screen, replaying
      the same alert twice on one overlay connection) and in Docker (session secret
      created as the node user, sign-in, persistence across restart).

## Phase 4 — Open-source release

- [x] 11. Someone else can self-host it from the README alone: NOWPayments setup,
      deployment (VPS, PaaS, home PC behind a tunnel), OBS setup. Licence and CI.
      Verified by following the Quick start on a fresh clone with Docker Compose,
      and by running the CI test job (typecheck, 416 tests) on Linux. The GitHub
      Actions workflow itself has not run yet: the repository is not on GitHub.

## Phase 5 — Retro-futuristic redesign

Agreed 2026-10-11. The look follows the streamer's socials site (purple-black
surfaces, cyan for anything interactive, magenta glow for atmosphere, Orbitron
and Share Tech Mono, hard corners, neon grid and scanlines).

- [x] 12. Every page shares the retro-futuristic design system: donation, thanks
      and error pages, test-alert page, admin page, and the OBS alert card. Fonts
      self-hosted; reduced motion honoured; no third-party requests.
      Verified in Chromium at desktop and 375px (no horizontal scroll, both fonts
      loaded, no CSP errors) and on the overlay with a test alert.
- [x] 13. Donors pick an amount from preset chips (DONATION_PRESETS) or a Custom
      chip that reveals an amount field. No JavaScript. Verified in Chromium.
- [x] 14. A public leaderboard shows "Top 100 donors" (totals per name,
      case-insensitive, Anonymous never ranked) and "Recent". Name, amount and
      date only; paid donations only; banned words masked. Donors opt out with a
      ticked-by-default checkbox; earlier donations are listed. LEADERBOARD=off
      disables it.
      Accepted risk: names are unverified, so two people with one name share a
      row, and anyone can donate under an existing name.
      Verified in Chromium at desktop and 375px, including the migration 4 backfill
      on existing data, name merging, opt-out, masking and the CSS tab switch.
- [x] 15. A small socials strip, configured by SOCIAL_LINKS, with icons copied
      from simple-icons (CC0). Empty means no strip.

## Phase 6 — Production

- [ ] 16. The service runs on an always-on AWS Lightsail instance (Ubuntu 24.04,
      $7 plan, 1 GB RAM, paid from AWS promotional credit) at a Cloudflare-managed
      subdomain, behind Caddy for automatic HTTPS, with Piper, a swap file, a
      nightly database backup, and an AWS budget alert.
      Considered and deferred (2026-10-11): Cloudflare Tunnel in front, with ports
      80/443 closed, to remove the bandwidth-overage risk from floods. Revisit if
      traffic or the bill ever looks wrong.
      The deploy is reproducible from files in deploy/ and the guide in
      deploy/README.md.
- [x] 17. Pushing to main deploys automatically once CI passes: GitHub Actions
      SSHes in with a deploy key restricted to deploy/update.sh, which backs up,
      fast-forwards, rebuilds, health-checks, and rolls back to the previous
      commit if the new version does not come up healthy.
      Deploy key verified to refuse a shell, file reads and port forwarding; host
      key pinned after matching three sources.
      Verified 2026-10-11: a docs push deployed in about 5 s on the server; a
      drill commit that crashed only in production failed its health check and
      rolled back by itself (about 1 min 40 s of 502s), and the run went red.
      Known limit: one app container, so a deploy that rebuilds has a short gap
      and a failed one is down until the rollback finishes.

## Phase 7 — On-stream extras

- [x] 18. A small on-stream table under the camera shows the 10 biggest single
      donations of all time, as its own OBS Browser Source (542 × 340 at x 19,
      y 376 in the streamer's 1920 × 1080 layout). Opted-out donors excluded,
      banned words masked, Anonymous shown; refreshes every 15 s.
      Verified in Chromium at 542 × 340 (29 px rows, both fonts) and live: a new
      $100 donation reached #1 within one refresh, with only that row animating.
- [x] 19. Starting Soon, Be Right Back and Ending Soon scenes as 1920 × 1080
      Browser Sources in the same design: glitch title, optional countdown on
      Starting Soon (?minutes=N), a donate panel with QR code, top donors and
      latest donations updating live, and the socials with their handles.
      Verified in Chromium at 1920 × 1080 for all three scenes (countdown only on
      Starting Soon, no overflow, all seven socials, live lists from the feed).
