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

const statusList = document.getElementById('live-status');
const platformNames = { twitch: 'Twitch', kick: 'Kick' };
const numberFormat = new Intl.NumberFormat();

/** "1:05:09" from a start time; empty when unknown. */
function uptime(startedAt) {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const parts = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  return `${parts[0]}:${String(parts[1]).padStart(2, '0')}:${String(parts[2]).padStart(2, '0')}`;
}

const stateLabels = { live: 'Live', offline: 'Offline', 'not-connected': 'Not connected', unknown: 'Unavailable' };

function renderStatuses(statuses) {
  statusList.replaceChildren(
    ...statuses.map((status) => {
      const chip = document.createElement('li');
      chip.className = `status-chip status-chip--${status.platform} status-chip--${status.state}`;
      const name = document.createElement('span');
      name.className = 'status-chip__platform';
      name.textContent = platformNames[status.platform] ?? status.platform;
      const state = document.createElement('span');
      state.className = 'status-chip__state';
      state.textContent = stateLabels[status.state] ?? status.state;
      chip.append(name, state);
      if (status.state === 'live') {
        const viewers = document.createElement('span');
        viewers.textContent = `${numberFormat.format(status.viewers ?? 0)} watching`;
        const time = document.createElement('span');
        time.className = 'status-chip__uptime';
        time.dataset.startedAt = status.startedAt ?? '';
        time.textContent = uptime(status.startedAt);
        chip.append(viewers, time);
        if (status.title) chip.title = status.title;
      }
      return chip;
    }),
  );
}

// Uptime ticks between the 30-second status updates.
setInterval(() => {
  for (const time of statusList.querySelectorAll('.status-chip__uptime')) {
    time.textContent = uptime(time.dataset.startedAt);
  }
}, 1000);

// ── Chat ──────────────────────────────────────────────────────────────────

const chatList = document.getElementById('chat');
const chatEmpty = document.getElementById('chat-empty');
const chatJump = document.getElementById('chat-jump');
/** Matches the server's buffer, so a long stream does not slow the page down. */
const maximumChat = 300;
const seenChatIds = new Set();
const badgeLabels = { broadcaster: 'Host', moderator: 'Mod', vip: 'VIP', subscriber: 'Sub', og: 'OG', founder: 'Founder' };

/** Viewer colours too dark to read on the dark panel fall back to the text colour. */
function readableColor(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex ?? '')) return '';
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance < 0.35 ? '' : hex;
}

function renderChat(message) {
  const row = document.createElement('li');
  row.className = `chat__message chat__message--${message.platform}`;
  row.dataset.id = message.id;
  row.dataset.platform = message.platform;
  row.dataset.userId = message.userId;
  const platform = document.createElement('span');
  platform.className = 'chat__platform';
  platform.textContent = message.platform === 'kick' ? 'K' : 'T';
  platform.title = message.platform === 'kick' ? 'Kick' : 'Twitch';
  row.append(platform);
  for (const badge of message.badges) {
    if (!(badge in badgeLabels)) continue;
    const label = document.createElement('span');
    label.className = `chat__badge chat__badge--${badge}`;
    label.textContent = badgeLabels[badge];
    row.append(label);
  }
  const user = document.createElement('span');
  user.className = 'chat__user';
  user.textContent = message.user;
  // A style property set from script, which the policy allows; never markup.
  const color = readableColor(message.color);
  if (color !== '') user.style.color = color;
  const text = document.createElement('span');
  text.className = 'chat__text';
  text.textContent = message.text;
  row.append(user, text);
  return row;
}

function isScrolledToBottom() {
  return chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 40;
}

function scrollChatToBottom() {
  chatList.scrollTop = chatList.scrollHeight;
  chatJump.hidden = true;
}

function addChat(messages) {
  const stick = isScrolledToBottom();
  for (const message of messages) {
    if (seenChatIds.has(message.id)) continue;
    seenChatIds.add(message.id);
    chatList.append(renderChat(message));
  }
  while (chatList.children.length > maximumChat) chatList.firstElementChild.remove();
  chatEmpty.hidden = chatList.children.length > 0;
  // Follow new messages unless the streamer scrolled up to read something.
  if (stick) scrollChatToBottom();
  else chatJump.hidden = false;
}

chatList.addEventListener('scroll', () => {
  if (isScrolledToBottom()) chatJump.hidden = true;
});
chatJump.addEventListener('click', scrollChatToBottom);

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

stream.addEventListener('chat-snapshot', (event) => {
  chatList.replaceChildren();
  seenChatIds.clear();
  addChat(JSON.parse(event.data));
  scrollChatToBottom();
});

stream.addEventListener('chat', (event) => {
  addChat([JSON.parse(event.data)]);
});

/** A moderator removed messages: one, one viewer's, or a platform's whole chat. */
stream.addEventListener('chat-remove', (event) => {
  const { removal } = JSON.parse(event.data);
  for (const row of [...chatList.children]) {
    const { id, platform, userId } = row.dataset;
    const removed =
      (removal.kind === 'message' && id === removal.id) ||
      (removal.kind === 'user' && platform === removal.platform && userId === removal.userId) ||
      (removal.kind === 'all' && platform === removal.platform);
    if (removed) row.remove();
  }
  chatEmpty.hidden = chatList.children.length > 0;
});

stream.addEventListener('status', (event) => {
  renderStatuses(JSON.parse(event.data));
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
