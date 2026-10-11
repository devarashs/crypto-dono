/*
 * On-stream table of the biggest donations, loaded by OBS as its own Browser
 * Source. Plain browser JavaScript with no build step.
 *
 * Polls a small JSON feed and only redraws when the list changed, so nothing
 * flickers on stream; an entry that is new since the last read fades in.
 */
import { createLiveList, pollJson, textElement } from './live-list.js';

const settings = document.body.dataset;
// Relative to the page URL (/overlay/<token>/board), so the token is never hard-coded.
const dataUrl = new URL(settings.dataUrl, window.location.href);
const refreshMs = Number(settings.refreshMs) || 15_000;

const update = createLiveList(
  document.getElementById('board-list'),
  document.getElementById('board-empty'),
  (donation) => `${donation.donorName}\u0000${donation.amount}`,
  (donation, index) => {
    const row = document.createElement('li');
    row.className = `board-row board-row--rank-${index + 1}`;
    row.append(
      textElement('span', 'board-row__rank', String(index + 1)),
      textElement('span', 'board-row__name', donation.donorName),
      textElement('span', 'board-row__amount', donation.amount),
    );
    return row;
  },
);

pollJson(dataUrl, refreshMs, ({ donations }) => update(donations));
