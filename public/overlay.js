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
/** The alert on screen, with a function that cuts it short. */
let current = null;

function enqueue(alert) {
  // A deliberate replay from the admin page is shown even if this id was seen.
  if (seenIds.has(alert.id) && alert.replay !== true) return;
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
  let skip;
  const skipped = new Promise((resolve) => {
    skip = resolve;
  });
  current = { id: alert.id, skip };
  /** Waits, unless the streamer skips this alert first. */
  const waitUnlessSkipped = (milliseconds) => Promise.race([wait(milliseconds), skipped]);
  let wasSkipped = false;
  void skipped.then(() => {
    wasSkipped = true;
  });

  const card = renderCard(alert);
  stage.replaceChildren(card);
  // Forces a style flush so the transition runs from the hidden state.
  void card.offsetWidth;
  card.classList.add('is-visible');
  const shownAt = performance.now();
  /** The audio element playing, when it is a file (null for tones and silence). */
  const sound = playAlertSound(alert);
  // The server decides per alert (e.g. below TTS_MIN_AMOUNT it is not spoken).
  const spoken = speechEnabled && alert.speak === true;
  if (spoken) {
    await waitUnlessSkipped(speechDelayMs);
    if (!wasSkipped) await speak(alert.id, skipped);
  }
  if (!wasSkipped) {
    // At least the configured duration, longer if the speech ran past it.
    const elapsedMs = performance.now() - shownAt;
    // Event alerts carry their own duration; donations use the page setting.
    const visibleMs = Math.max(alert.durationMs ?? alertDurationMs, spoken ? elapsedMs + holdAfterSpeechMs : 0);
    await waitUnlessSkipped(visibleMs - elapsedMs);
  }
  // A soundboard sound is the alert itself: stay up until it finishes, within its limit.
  if (!wasSkipped && alert.soundLimitMs !== undefined && sound !== null) {
    await Promise.race([untilEnded(sound), wait(alert.soundLimitMs - (performance.now() - shownAt)), skipped]);
  }
  if (alert.soundLimitMs !== undefined && sound !== null) sound.pause();
  current = null;
  card.classList.remove('is-visible');
  await wait(exitDurationMs);
  card.remove();
}

/** Built with textContent only: donor text must never be interpreted as HTML. */
function renderCard(alert) {
  if (alert.headline !== undefined) return renderEventCard(alert);
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

/**
 * A follow, sub, gift, cheer or raid. The server has already worded it as
 * parts; numbers are emphasised. A small platform badge sits above it.
 */
function renderEventCard(alert) {
  const card = document.createElement('div');
  card.className = `alert-card alert-card--event alert-card--${alert.kind}`;

  if (alert.badge !== undefined) {
    const badge = document.createElement('p');
    badge.className = 'alert-badge';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'alert-badge__icon');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', alert.badge.iconPath);
    icon.append(path);
    badge.append(icon, alert.badge.label);
    card.append(badge);
  }

  const headline = document.createElement('p');
  headline.className = 'alert-headline';
  for (const part of alert.headline) {
    if (part.emphasis) {
      const emphasis = document.createElement('span');
      emphasis.className = 'alert-amount';
      emphasis.textContent = part.text;
      headline.append(emphasis);
    } else {
      headline.append(part.text);
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

/** Custom event sounds, one element per file so each is fetched once. */
const eventSounds = new Map();

/** @returns The audio element playing a sound file, or null for a tone or silence. */
function playAlertSound(alert) {
  if (alert.sound !== undefined) return playEventSound(alert.sound);
  if (soundSetting === 'none') return null;
  if (soundSetting === 'chime') {
    playChime();
    return null;
  }
  // One element reused, so the file is fetched once and then served from cache.
  customSound ??= new Audio(new URL(soundSetting, window.location.href).href);
  customSound.currentTime = 0;
  // Rejected when the browser blocks autoplay; OBS does not, a normal tab may.
  customSound.play().catch(() => {});
  return customSound;
}

/** @returns The audio element for a file cue, or null for a tone or silence. */
function playEventSound(cue) {
  if (cue.type === 'none') return null;
  if (cue.type === 'tone') {
    playTone(cue.tone);
    return null;
  }
  const url = new URL(cue.path, eventsUrl).href;
  if (!eventSounds.has(url)) eventSounds.set(url, new Audio(url));
  const sound = eventSounds.get(url);
  sound.currentTime = 0;
  sound.play().catch(() => {});
  return sound;
}

/**
 * Resolves when the sound finishes or fails; a broken file must not hold up the
 * queue. Already paused covers both "finished" and "never started" (autoplay
 * blocked in a normal browser tab).
 */
function untilEnded(audio) {
  if (audio.paused || audio.ended || audio.error !== null) return Promise.resolve();
  return new Promise((resolve) => {
    audio.addEventListener('ended', resolve, { once: true });
    audio.addEventListener('error', resolve, { once: true });
    audio.addEventListener('pause', resolve, { once: true });
  });
}

/**
 * Built-in tones, one per event kind, so they can be told apart by ear:
 * frequencies (Hz), gap between notes (s), and each note's length (s).
 */
const eventTones = {
  follow: { notes: [880], gap: 0, length: 0.35, wave: 'sine', volume: 0.18 },
  sub: { notes: [523, 659, 784], gap: 0.12, length: 0.45, wave: 'triangle', volume: 0.22 },
  gift: { notes: [523, 659, 784, 1047], gap: 0.09, length: 0.4, wave: 'triangle', volume: 0.22 },
  cheer: { notes: [1047, 1319, 1568, 2093], gap: 0.06, length: 0.3, wave: 'sine', volume: 0.16 },
  raid: { notes: [220, 330, 440, 660], gap: 0.16, length: 0.6, wave: 'sawtooth', volume: 0.1 },
};

function playTone(kind) {
  const tone = eventTones[kind] ?? eventTones.follow;
  playNotes(tone.notes, tone.gap, tone.length, tone.wave, tone.volume);
}

/** Plays notes in sequence with a quick attack and a soft decay. */
function playNotes(frequencies, gap, length, wave, volume) {
  try {
    audioContext ??= new AudioContext();
    const start = audioContext.currentTime;
    frequencies.forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const noteStart = start + index * gap;
      oscillator.type = wave;
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, noteStart);
      gain.gain.linearRampToValueAtTime(volume, noteStart + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, noteStart + length);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteStart + length);
    });
  } catch {
    // No audio is better than no alert.
  }
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
function speak(alertId, skipped) {
  const audio = new Audio(new URL(`alerts/${encodeURIComponent(alertId)}/speech`, eventsUrl).href);
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(safetyTimer);
      resolve();
    };
    void skipped.then(() => {
      audio.pause();
      finish();
    });
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
/** The streamer skipped an alert from the admin page: drop it if queued, end it if showing. */
events.addEventListener('skip', (event) => {
  try {
    const { id } = JSON.parse(event.data);
    seenIds.add(id);
    const queuedIndex = queue.findIndex((alert) => alert.id === id);
    if (queuedIndex !== -1) queue.splice(queuedIndex, 1);
    if (current !== null && current.id === id) current.skip();
  } catch {
    // A malformed event is ignored.
  }
});

events.addEventListener('alert', (event) => {
  try {
    enqueue(JSON.parse(event.data));
  } catch {
    // A malformed event is skipped rather than stopping the overlay.
  }
});
