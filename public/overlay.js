/*
 * OBS overlay client. Plain browser JavaScript with no build step: OBS's Browser
 * Source loads it as is.
 *
 * Alerts arrive over Server-Sent Events and play one at a time from a queue, so
 * donations that land together are each shown in full. After an alert has been
 * shown it is acknowledged, which stops the server replaying it on reconnect.
 */
'use strict';

const stage = document.getElementById('alert-stage');
// Relative to the page URL (/overlay/<token>), so the token is never hard-coded.
const eventsUrl = new URL(document.body.dataset.eventsUrl, window.location.href);
const alertDurationMs = Number(document.body.dataset.alertDurationMs) || 8000;
/** Matches --overlay-exit-duration, plus a little slack before the next alert. */
const exitDurationMs = 200;
const gapBetweenAlertsMs = 600;

const queue = [];
/** Ids already queued or shown, so a replay after reconnect is not shown twice. */
const seenIds = new Set();
let isPlaying = false;

function enqueue(alert) {
  if (seenIds.has(alert.id)) return;
  seenIds.add(alert.id);
  queue.push(alert);
  if (!isPlaying) void playQueue();
}

async function playQueue() {
  isPlaying = true;
  while (queue.length > 0) {
    const alert = queue.shift();
    await showAlert(alert);
    acknowledge(alert.id);
    await wait(gapBetweenAlertsMs);
  }
  isPlaying = false;
}

async function showAlert(alert) {
  const card = renderCard(alert);
  stage.replaceChildren(card);
  // Forces a style flush so the transition runs from the hidden state.
  void card.offsetWidth;
  card.classList.add('is-visible');
  playChime();
  await wait(alertDurationMs);
  card.classList.remove('is-visible');
  await wait(exitDurationMs);
  card.remove();
}

/** Built with textContent only: donor text must never be interpreted as HTML. */
function renderCard(alert) {
  const card = document.createElement('div');
  card.className = 'alert-card';

  const headline = document.createElement('p');
  headline.className = 'alert-headline';
  const amount = document.createElement('span');
  amount.className = 'alert-amount';
  amount.textContent = alert.amount;
  headline.append(`${alert.donorName} donated `, amount);
  card.append(headline);

  if (alert.message !== '') {
    const message = document.createElement('p');
    message.className = 'alert-message';
    message.textContent = alert.message;
    card.append(message);
  }
  return card;
}

function acknowledge(id) {
  const url = new URL(`alerts/${encodeURIComponent(id)}/shown`, eventsUrl);
  // A failed acknowledgement only means the alert may be replayed later.
  fetch(url, { method: 'POST' }).catch(() => {});
}

let audioContext;

/**
 * A short two-note chime synthesised with Web Audio, so the default needs no
 * sound file. Web Audio goes through the Browser Source's own audio, so it shows
 * on OBS's mixer when "Control audio via OBS" is ticked.
 */
function playChime() {
  try {
    audioContext ??= new AudioContext();
    const start = audioContext.currentTime;
    [660, 880].forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const noteStart = start + index * 0.15;
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, noteStart);
      gain.gain.linearRampToValueAtTime(0.25, noteStart + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, noteStart + 0.6);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteStart + 0.6);
    });
  } catch {
    // No audio is better than no alert.
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const events = new EventSource(eventsUrl);
events.addEventListener('alert', (event) => {
  try {
    enqueue(JSON.parse(event.data));
  } catch {
    // A malformed event is skipped rather than stopping the overlay.
  }
});
