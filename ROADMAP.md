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

- [x] 16. The service runs on an always-on AWS Lightsail instance (Ubuntu 24.04,
      $7 plan, 1 GB RAM, paid from AWS promotional credit) at a Cloudflare-managed
      subdomain, behind Caddy for automatic HTTPS, with Piper, a swap file, a
      nightly database backup, and an AWS budget alert.
      Verified 2026-10-11: live at https://dono.devarash.icu, and the streamer made
      a real donation that alerted on stream end to end.
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
      banned words masked, Anonymous shown; refreshes every 15 s. (Changed
      2026-10-12 at the streamer's request: Anonymous is now left out of every
      public list, this table and the Latest lists included.)
      Verified in Chromium at 542 × 340 (29 px rows, both fonts) and live: a new
      $100 donation reached #1 within one refresh, with only that row animating.
- [x] 19. Starting Soon, Be Right Back and Ending Soon scenes as 1920 × 1080
      Browser Sources in the same design: glitch title, optional countdown on
      Starting Soon (?minutes=N), a donate panel with QR code, top donors and
      latest donations updating live, and the socials with their handles.
      Verified in Chromium at 1920 × 1080 for all three scenes (countdown only on
      Starting Soon, no overflow, all seven socials, live lists from the feed).

## Phase 8 — Platform alerts

Agreed 2026-10-11: unified follow, sub, bits and raid alerts in the same overlay,
replacing StreamElements for these. Twitch and Kick push events in real time;
YouTube cannot (no push for new subscribers; the subscriber list only shows
public subscriptions and lags), so it comes last and with its limits stated.

- [x] 20. The overlay shows platform events alongside donations, in one queue:
      follow, subscription (new and resub with months), gift subs (one alert per
      gift), cheer, raid. Per-kind wording and sound from .env, a platform icon on
      each card, and test buttons for every kind on the test-alert page.
      Verified in Chromium: raid, follow (compact card) and resub with message,
      queued behind a pending donation, with Twitch and Kick badges.
- [x] 21. Twitch: OAuth connect from the admin page, EventSub webhooks with
      verified signatures, de-duplication and revocation handling; off unless
      TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are set. Verified up to Twitch
      on 2026-10-11 (all six subscriptions enabled; a signed notification sent
      on the server reached the overlay), but no real events arrived while the
      channel was offline, so it was shelved. On 2026-10-12 the streamer
      reconnected and reported real follow alerts arriving while live.

## Phase 9 — Soundboard

Agreed 2026-10-12: viewers pay for a sound from a list the streamer provides,
and it plays on stream. Its own page; name only, no message and no TTS; the
listed price exactly; purchases count as donations everywhere (leaderboard and
on-stream table, respecting the opt-out).

- [x] 24. The streamer's sound list: `soundboard.json` in CUSTOM_ASSETS_DIR
      (id, name, price, file). Checked at startup: a missing file, duplicate id,
      or price outside the donation range turns the soundboard off and logs the
      entry. (First built to stop the service; changed 2026-10-12 after a bad id
      took the site down in production. Ids now allow capitals and underscores.)
      No file means no soundboard. Sound files are served publicly for preview.
- [x] 25. A `/sounds` page: each sound with its price and a preview, pick one,
      name and leaderboard choice, pay. The invoice uses the price from the
      list, never from the form. The donation records the sound's id, name and
      price at purchase (migration 7). Linked from the donation page.
      Revised 2026-10-12 at the streamer's request: a grid of pads, cheapest
      first, with a small preview button per pad (public/sound-preview.js; the
      page still works as a plain form without it).
- [x] 26. On stream: a paid sound shows "{name} played {sound}" and plays that
      file instead of the chime, cut off after 20 seconds. Queued, replayable
      and skippable like any donation, with a test button per sound. Proven with
      a signed payment notification, watching the overlay play it.
      Verified in Chromium: the /sounds page at desktop and phone width with
      previews playing; on the overlay, a test purchase showed "Test viewer
      played Air horn" with its file, and a 25-second clip held the card until
      it was cut off at 20 seconds. A signed IPN for a bought sound published
      the sound alert (route test).

## Phase 10 — Kick alerts

Agreed 2026-10-13, after Twitch alerts were confirmed working live. Checked
against docs.kick.com first: webhooks are signed by Kick with RSA (SHA-256,
PKCS#1 v1.5) over "message id.timestamp.raw body", verified with the public key
from api.kick.com/public/v1/public-key; the webhook URL is set once in the
Kick app's settings. Kick's public API has no raid or host event, so Kick
raids cannot alert.

- [x] 27. Receive Kick events at POST /webhooks/kick: signature verified against
      Kick's public key (fetched, cached, re-fetched once if a signature fails,
      since Kick may rotate it), stale and duplicate messages refused. Follows,
      new subs, renewals (as resubs with months), gift subs (one alert per gift)
      and Kicks ("{name} sent {kicks} Kicks", on the cheer switch and sound, own
      wording in EVENT_TEMPLATE_KICKS). Message de-duplication moves to one table
      for every platform (migration 8). Tested with messages signed by a
      generated key, built as Kick's docs describe.
- [ ] 28. Connect Kick from the admin page: OAuth 2.1 with PKCE identifies the
      streamer and subscribes to the five events; Disconnect removes them.
      Off unless KICK_CLIENT_ID and KICK_CLIENT_SECRET are set. Done when a real
      follow on the streamer's Kick channel alerts. Open questions to settle
      live: whether a renewal's duration is cumulative months, and whether
      subscriptions outlive the user token used to create them.
      Decided 2026-10-13: until a real renewal settles it, Kick resubs show
      "{name} resubscribed" with no number (right either way), and the server
      logs Kick's duration so it can be compared with the viewer's badge.
- [ ] 29. Daily subscription health check for Twitch and Kick: at startup and
      once a day the server asks each platform which alert subscriptions exist;
      any expected one that is missing or not enabled is shown on the admin
      page with a Reconnect button. Alerts keep flowing for the rest. No user
      tokens are stored; if Kick turns out to drop subscriptions when the user
      token expires, refreshing it becomes a separate item.

## Phase 11 — Live dashboard

Agreed 2026-10-13: one admin page for streaming to Twitch, Kick and YouTube at
once (OBS multistream), instead of three tabs. Decided: chat read-only; Twitch
and Kick only (no YouTube); viewers' chat is never saved, only the last few
hundred messages kept in memory; laid out for a wide browser window.

- [ ] 30. /admin/live, behind the admin password and updating live: an activity
      feed of follows, subs, gift subs, bits, Kicks, raids, donations with their
      messages and soundboard purchases, newest first. Platform events are now
      stored (migration 9) and kept 30 days, so the feed survives a reload.
- [ ] 31. A status bar: Twitch and Kick live or offline, viewers and uptime,
      refreshed every 30 s with each app's own token. (Neither platform exposes
      encoder health; OBS shows that.)
- [ ] 32. Kick chat in the dashboard, through the existing webhook
      (chat.message.sent; Reconnect Kick once to add it). Last 300 messages in
      memory, never stored.
- [ ] 33. Twitch chat in the dashboard: the server joins the channel's chat
      anonymously and read-only, reconnecting on its own. Merged with Kick chat
      in one column, a platform icon on each message; emotes as text for now.

## Deferred ideas

- Donor-chosen text-to-speech voices (one multi-speaker Piper model, e.g.
  en_US-libritts_r-medium, CC BY 4.0, with named picks). Raised and set aside
  2026-10-11 in favour of platform alerts.
- YouTube event alerts (was item 23). Dropped on 2026-10-11; Kick was picked
  up again as Phase 10.
