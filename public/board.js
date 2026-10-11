/*
 * On-stream table of the biggest donations, loaded by OBS as its own Browser
 * Source. Plain browser JavaScript with no build step.
 *
 * It polls a small JSON feed and only touches the page when the list actually
 * changed, so nothing flickers on stream. An entry that is new since the last
 * read fades in.
 */
const settings = document.body.dataset;
// Relative to the page URL (/overlay/<token>/board), so the token is never hard-coded.
const dataUrl = new URL(settings.dataUrl, window.location.href);
const refreshMs = Number(settings.refreshMs) || 15_000;

const list = document.getElementById('board-list');
const emptyState = document.getElementById('board-empty');

/** The last list drawn, to skip redraws and spot new entries. */
let previousKeys = null;

const keyOf = (donation) => `${donation.donorName}\u0000${donation.amount}`;

async function refresh() {
  let donations;
  try {
    const response = await fetch(dataUrl, { cache: 'no-store' });
    if (!response.ok) return;
    ({ donations } = await response.json());
  } catch {
    // Server unreachable for a moment: keep showing the last good list.
    return;
  }

  const keys = donations.map(keyOf);
  if (previousKeys !== null && keys.join('\n') === previousKeys.join('\n')) return;
  const known = new Set(previousKeys ?? keys);
  previousKeys = keys;

  emptyState.hidden = donations.length > 0;
  list.replaceChildren(
    ...donations.map((donation, index) => renderRow(donation, index, !known.has(keys[index]))),
  );
}

/** Built with textContent only: donor names must never be interpreted as HTML. */
function renderRow(donation, index, isNew) {
  const row = document.createElement('li');
  row.className = `board-row board-row--rank-${index + 1}${isNew ? ' is-new' : ''}`;

  const rank = document.createElement('span');
  rank.className = 'board-row__rank';
  rank.textContent = String(index + 1);

  const name = document.createElement('span');
  name.className = 'board-row__name';
  name.textContent = donation.donorName;

  const amount = document.createElement('span');
  amount.className = 'board-row__amount';
  amount.textContent = donation.amount;

  row.append(rank, name, amount);
  return row;
}

void refresh();
setInterval(() => void refresh(), refreshMs);
