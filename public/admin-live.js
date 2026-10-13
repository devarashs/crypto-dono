/*
 * Live dashboard client: fills the activity list from /admin/live/stream.
 * The server sends text already worded as headline parts; everything is placed
 * with textContent, never parsed as HTML.
 */
const list = document.getElementById('activity');
const empty = document.getElementById('activity-empty');
const connection = document.getElementById('live-connection');

/** Enough scrollback for a long stream without the page growing forever. */
const maximumItems = 200;
const seenIds = new Set();

const sourceLabels = { twitch: 'Twitch', kick: 'Kick', donation: 'Donation', sound: 'Sound' };
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

function renderItem(item) {
  const row = document.createElement('li');
  row.className = `activity__item activity__item--${item.source}`;

  const meta = document.createElement('p');
  meta.className = 'activity__meta';
  const badge = document.createElement('span');
  badge.className = 'activity__source';
  badge.textContent = sourceLabels[item.source] ?? item.source;
  const time = document.createElement('time');
  time.dateTime = item.at;
  time.textContent = timeFormat.format(new Date(item.at));
  meta.append(badge, time);

  const headline = document.createElement('p');
  headline.className = 'activity__headline';
  for (const part of item.headline) {
    if (part.emphasis) {
      const strong = document.createElement('strong');
      strong.textContent = part.text;
      headline.append(strong);
    } else {
      headline.append(part.text);
    }
  }
  row.append(meta, headline);

  if (item.message) {
    const message = document.createElement('p');
    message.className = 'activity__message';
    message.textContent = item.message;
    row.append(message);
  }
  return row;
}

function updateEmptyState() {
  empty.hidden = list.children.length > 0;
}

const stream = new EventSource('/admin/live/stream');

stream.addEventListener('open', () => {
  connection.textContent = 'Live';
  connection.dataset.state = 'live';
});

stream.addEventListener('error', () => {
  // EventSource reconnects by itself; this only says so.
  connection.textContent = 'Reconnecting…';
  connection.dataset.state = 'down';
});

/** Sent on every (re)connect: replaces the list with the latest history. */
stream.addEventListener('snapshot', (event) => {
  const items = JSON.parse(event.data);
  seenIds.clear();
  list.replaceChildren(
    ...items.map((item) => {
      seenIds.add(item.id);
      return renderItem(item);
    }),
  );
  updateEmptyState();
});

stream.addEventListener('activity', (event) => {
  const item = JSON.parse(event.data);
  if (seenIds.has(item.id)) return;
  seenIds.add(item.id);
  const row = renderItem(item);
  row.classList.add('is-new');
  list.prepend(row);
  while (list.children.length > maximumItems) list.lastElementChild.remove();
  updateEmptyState();
});
