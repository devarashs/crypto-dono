/**
 * The live dashboard page: a shell that public/admin-live.js fills from the
 * /admin/live/stream event stream. Laid out for a wide window: status across
 * the top, chat on the left, activity on the right.
 */
import { html, type SafeHtml } from './html.ts';
import { layout } from './pages.ts';

export function renderLiveDashboardPage(): SafeHtml {
  return layout(
    'Live dashboard',
    html`
      <div class="live">
        <header class="live__header">
          <h1 class="panel__heading">Live</h1>
          <ul class="live__status" id="live-status" aria-label="Stream status"></ul>
          <p class="live__connection" id="live-connection" role="status">Connecting…</p>
          <a class="link" href="/admin">Admin</a>
        </header>
        <section class="live__panel live__panel--chat" aria-labelledby="live-chat-title">
          <div class="live__panel-header">
            <h2 class="panel__title" id="live-chat-title">Chat</h2>
            <form method="post" action="/admin/live/chat/clear">
              <button class="button button--ghost button--small" type="submit">Clear chat</button>
            </form>
          </div>
          <p class="footnote">Clears here, on the chat overlay and on the scenes. Chat also clears by itself when your stream goes live.</p>
          <ol class="chat" id="chat" aria-live="off"></ol>
          <p class="empty-state" id="chat-empty" hidden>No chat yet. Twitch and Kick messages show up here, newest at the bottom.</p>
          <button class="button button--small chat__jump" id="chat-jump" type="button" hidden>New messages</button>
        </section>
        <section class="live__panel live__panel--activity" aria-labelledby="live-activity-title">
          <h2 class="panel__title" id="live-activity-title">Activity</h2>
          <noscript><p class="field__error">This page needs JavaScript to update live.</p></noscript>
          <ol class="activity" id="activity" aria-live="polite"></ol>
          <p class="empty-state" id="activity-empty" hidden>Nothing yet. Follows, subs, donations and sounds show up here.</p>
        </section>
      </div>
    `,
    { wide: true, script: '/static/admin-live.js' },
  );
}
