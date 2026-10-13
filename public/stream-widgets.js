/*
 * The chat list and viewer count as they appear on stream, shared by the chat
 * overlay, the viewer overlay and the scenes. Text is placed with textContent
 * only; the server has already masked banned words.
 */

/** Emote images only ever come from the platforms' own CDNs. */
const emoteOrigins = new Set(['https://static-cdn.jtvnw.net', 'https://files.kick.com']);

/**
 * Fills `element` with a message's text: emotes as images (their name as alt
 * text, and as plain text if an image fails), everything else as text.
 */
export function fillChatText(element, message) {
  if (!Array.isArray(message.fragments)) {
    element.textContent = message.text;
    return;
  }
  for (const fragment of message.fragments) {
    if (typeof fragment.text === 'string') {
      element.append(fragment.text);
      continue;
    }
    let url;
    try {
      url = new URL(fragment.url);
    } catch {
      element.append(fragment.emote);
      continue;
    }
    if (!emoteOrigins.has(url.origin)) {
      element.append(fragment.emote);
      continue;
    }
    const image = document.createElement('img');
    image.className = 'chat-emote';
    image.src = url.href;
    image.alt = fragment.emote;
    image.title = fragment.emote;
    image.addEventListener('error', () => image.replaceWith(fragment.emote), { once: true });
    element.append(image);
  }
}

/** Too-dark viewer colours fall back to the stylesheet's colour. */
function readableColor(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex ?? '')) return '';
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.35 ? '' : hex;
}

function matchesRemoval(row, removal) {
  const { id, platform, userId } = row.dataset;
  return (
    (removal.kind === 'message' && id === removal.id) ||
    (removal.kind === 'user' && platform === removal.platform && userId === removal.userId) ||
    (removal.kind === 'all' && platform === removal.platform)
  );
}

/** Matches --overlay-exit-duration-ish: long enough for the fade to finish. */
const leaveMs = 400;

/**
 * A chat list that keeps the newest `maxMessages`, and lets each one fade out
 * `fadeSeconds` after it was sent (0: they stay until pushed out).
 */
export function createStreamChat(list, { maxMessages, fadeSeconds }) {
  const shownIds = new Set();

  function leave(row) {
    if (!row.isConnected || row.classList.contains('is-leaving')) return;
    row.classList.add('is-leaving');
    setTimeout(() => {
      row.remove();
      shownIds.delete(row.dataset.id);
    }, leaveMs);
  }

  function render(message) {
    const row = document.createElement('li');
    row.className = `stream-chat__message stream-chat__message--${message.platform}`;
    Object.assign(row.dataset, { id: message.id, platform: message.platform, userId: message.userId });
    const platform = document.createElement('span');
    platform.className = 'stream-chat__platform';
    platform.textContent = message.platform === 'kick' ? 'K' : 'T';
    const user = document.createElement('span');
    user.className = 'stream-chat__user';
    user.textContent = message.user;
    const color = readableColor(message.color);
    if (color !== '') user.style.color = color;
    const text = document.createElement('span');
    text.className = 'stream-chat__text';
    fillChatText(text, message);
    row.append(platform, user, text);
    return row;
  }

  function add(message) {
    if (shownIds.has(message.id)) return;
    // Already past its time (an old message in a snapshot): not shown at all.
    const remainingMs = fadeSeconds === 0 ? Infinity : Date.parse(message.at) + fadeSeconds * 1000 - Date.now();
    if (remainingMs <= 0) return;
    shownIds.add(message.id);
    const row = render(message);
    list.append(row);
    const rows = [...list.children].filter((child) => !child.classList.contains('is-leaving'));
    for (const old of rows.slice(0, Math.max(0, rows.length - maxMessages))) leave(old);
    if (Number.isFinite(remainingMs)) setTimeout(() => leave(row), remainingMs);
  }

  return {
    snapshot(messages) {
      list.replaceChildren();
      shownIds.clear();
      for (const message of messages.slice(-maxMessages)) add(message);
    },
    add,
    remove(removal) {
      for (const row of [...list.children]) if (matchesRemoval(row, removal)) leave(row);
    },
  };
}

const numberFormat = new Intl.NumberFormat();
const platformNames = { twitch: 'Twitch', kick: 'Kick' };

/**
 * Fills a viewer pill: total watching, then each live platform. Hidden while
 * no platform is live (or the status is not known yet).
 */
export function renderViewerCount(element, statuses) {
  const live = statuses.filter((status) => status.state === 'live');
  element.hidden = live.length === 0;
  if (live.length === 0) return;
  const total = live.reduce((sum, status) => sum + (status.viewers ?? 0), 0);
  const headline = document.createElement('p');
  headline.className = 'viewer-pill__total';
  const dot = document.createElement('span');
  dot.className = 'viewer-pill__dot';
  dot.setAttribute('aria-hidden', 'true');
  const number = document.createElement('strong');
  number.textContent = numberFormat.format(total);
  headline.append(dot, number, ' watching');
  const breakdown = document.createElement('p');
  breakdown.className = 'viewer-pill__platforms';
  breakdown.textContent = live
    .map((status) => `${platformNames[status.platform] ?? status.platform} ${numberFormat.format(status.viewers ?? 0)}`)
    .join(' · ');
  element.replaceChildren(headline, breakdown);
}
