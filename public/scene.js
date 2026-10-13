/*
 * Stream scenes (Starting Soon, Be Right Back, Ending Soon): live donor lists
 * and the optional Starting Soon countdown. Plain ES module, no build step.
 *
 * Countdown: add ?minutes=N to the Browser Source URL (1 to 180). It counts from
 * when the page loads, so with OBS's "Refresh browser when scene becomes active"
 * it restarts every time you switch to the scene.
 */
import { createLiveList, pollJson, textElement } from './live-list.js';
import { connectLiveStream } from './live-stream.js';
import { createStreamChat, renderViewerCount } from './stream-widgets.js';

const settings = document.body.dataset;
const feedUrl = new URL(settings.feedUrl, window.location.href);
const refreshMs = Number(settings.refreshMs) || 15_000;

const renderRow = (entry, index) => {
  const row = document.createElement('li');
  row.className = `scene-row scene-row--rank-${index + 1}`;
  row.append(textElement('span', 'scene-row__name', entry.donorName), textElement('span', 'scene-row__amount', entry.amount));
  return row;
};
const keyOf = (entry) => `${entry.donorName}\u0000${entry.amount}`;

const updateTopDonors = createLiveList(
  document.getElementById('top-donors'),
  document.getElementById('top-donors-empty'),
  keyOf,
  renderRow,
);
const updateLatest = createLiveList(document.getElementById('latest'), document.getElementById('latest-empty'), keyOf, renderRow);

pollJson(feedUrl, refreshMs, ({ topDonors, latest }) => {
  updateTopDonors(topDonors);
  updateLatest(latest);
});

startCountdown();

function startCountdown() {
  if (settings.countdown !== 'on') return;
  const minutes = Number(new URLSearchParams(window.location.search).get('minutes'));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 180) return;

  const element = document.getElementById('countdown');
  const endsAt = Date.now() + minutes * 60_000;
  element.hidden = false;

  const tick = () => {
    const remainingSeconds = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    if (remainingSeconds === 0) {
      element.textContent = 'Starting any second';
      element.classList.add('scene__countdown--done');
      return;
    }
    const mm = String(Math.floor(remainingSeconds / 60)).padStart(2, '0');
    const ss = String(remainingSeconds % 60).padStart(2, '0');
    element.textContent = `${mm}:${ss}`;
    // Aligned to the next whole second, so the display never skips or stutters.
    setTimeout(tick, 1000 - (Date.now() % 1000));
  };
  tick();
}

// Chat and the viewer count, from the overlay's live stream. Messages stay on a
// scene (no fade): it is what people watch while you are away.
const chat = createStreamChat(document.getElementById('chat'), { maxMessages: 14, fadeSeconds: 0 });
const viewers = document.getElementById('viewers');
connectLiveStream(settings.streamUrl, {
  chatSnapshot: chat.snapshot,
  chat: chat.add,
  chatRemove: chat.remove,
  status: (statuses) => renderViewerCount(viewers, statuses),
});
