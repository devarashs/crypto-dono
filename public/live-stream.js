/*
 * Connects a stream page (chat overlay, viewer count, scenes) to the overlay's
 * live event stream: chat, moderators' removals, and channel status. Shared so
 * every page reads the stream the same way.
 */

/**
 * @param url The /overlay/<token>/live stream, absolute or relative to the page.
 * @param handlers Each optional: chatSnapshot(messages), chat(message),
 *   chatRemove(removal), status(statuses).
 */
export function connectLiveStream(url, handlers) {
  const events = new EventSource(new URL(url, window.location.href));
  const on = (type, handler) => {
    if (handler === undefined) return;
    events.addEventListener(type, (event) => {
      try {
        handler(JSON.parse(event.data));
      } catch {
        // A malformed event is skipped rather than stopping the page.
      }
    });
  };
  on('chat-snapshot', handlers.chatSnapshot);
  on('chat', handlers.chat);
  on('chat-remove', (data) => handlers.chatRemove?.(data.removal));
  on('status', handlers.status);
  return events;
}
