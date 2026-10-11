/*
 * OBS overlay client. Plain browser JavaScript with no build step: OBS's Browser
 * Source loads it as is.
 *
 * Alerts arrive over Server-Sent Events and play one at a time from a queue, so
 * donations that land together are each shown in full. After an alert has been
 * shown it is acknowledged, which stops the server replaying it on reconnect.
 *
 * Settings arrive as data attributes on <body>, rendered from the streamer's .env.
 */
import { splitAlertTemplate } from './alert-template.js';

const stage = document.getElementById('alert-stage');
const settings = document.body.dataset;
// Relative to the page URL (/overlay/<token>), so the token is never hard-coded.
const eventsUrl = new URL(settings.eventsUrl, window.location.href);
const alertDurationMs = Number(settings.alertDurationMs) || 8000;
const templateParts = splitAlertTemplate(settings.textTemplate || '{name} donated {amount}');
/** "chime", "none", or the URL of the streamer's own sound. */
const soundSetting = settings.sound || 'chime';
const imageUrl = settings.imageUrl ? new URL(settings.imageUrl, window.location.href).href : '';
const speechEnabled = settings.speech === 'on';
/** Lets the alert sound start before the voice, so the two do not talk over each other. */
const speechDelayMs = 1200;
/** The card stays this long after the voice finishes, so the message can be read. */
const holdAfterSpeechMs = 1000;
/** A stuck audio element must never freeze the queue. */
const maximumSpeechMs = 60_000;
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
  const shownAt = performance.now();
  playAlertSound();
  // The server decides per alert (e.g. below TTS_MIN_AMOUNT it is not spoken).
  const spoken = speechEnabled && alert.speak === true;
  if (spoken) {
    await wait(speechDelayMs);
    await speak(alert.id);
  }
  // At least the configured duration, longer if the speech ran past it.
  const elapsedMs = performance.now() - shownAt;
  const visibleMs = Math.max(alertDurationMs, spoken ? elapsedMs + holdAfterSpeechMs : 0);
  await wait(visibleMs - elapsedMs);
  card.classList.remove('is-visible');
  await wait(exitDurationMs);
  card.remove();
}

/** Built with textContent only: donor text must never be interpreted as HTML. */
function renderCard(alert) {
  const card = document.createElement('div');
  card.className = 'alert-card';

  if (imageUrl !== '') {
    const image = document.createElement('img');
    image.className = 'alert-image';
    image.src = imageUrl;
    image.alt = '';
    card.append(image);
  }

  const headline = document.createElement('p');
  headline.className = 'alert-headline';
  for (const part of templateParts) {
    if (part.type === 'text') {
      headline.append(part.value);
    } else if (part.type === 'name') {
      headline.append(alert.donorName);
    } else {
      const amount = document.createElement('span');
      amount.className = 'alert-amount';
      amount.textContent = alert.amount;
      headline.append(amount);
    }
  }
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
let customSound;

function playAlertSound() {
  if (soundSetting === 'none') return;
  if (soundSetting === 'chime') {
    playChime();
    return;
  }
  // One element reused, so the file is fetched once and then served from cache.
  customSound ??= new Audio(new URL(soundSetting, window.location.href).href);
  customSound.currentTime = 0;
  // Rejected when the browser blocks autoplay; OBS does not, a normal tab may.
  customSound.play().catch(() => {});
}

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

/**
 * Plays the alert's speech from the server and resolves when it ends. Also
 * resolves on any failure (Piper down, unknown alert, blocked autoplay), because
 * a missing voice must never hold up the alert queue.
 */
function speak(alertId) {
  const audio = new Audio(new URL(`alerts/${encodeURIComponent(alertId)}/speech`, eventsUrl).href);
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(safetyTimer);
      resolve();
    };
    const safetyTimer = setTimeout(finish, maximumSpeechMs);
    audio.addEventListener('ended', finish, { once: true });
    audio.addEventListener('error', finish, { once: true });
    audio.play().catch(finish);
  });
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
