/**
 * Admin pages: login, and the donation history with alert controls.
 * Server-rendered forms with no client JavaScript, like the public pages.
 */
import type { Donation } from '../donations/donation-repository.ts';
import { formatMoneyForDisplay } from '../money.ts';
import { html, type SafeHtml } from './html.ts';
import { layout, panel, renderField } from './pages.ts';

export function renderLoginPage(model: { error?: string } = {}): SafeHtml {
  return layout(
    'Admin sign in',
    panel(html`
      <h1 class="panel__heading">Admin</h1>
      <p class="muted">Sign in with the ADMIN_PASSWORD from your .env file.</p>
      <form class="form" method="post" action="/admin/login" novalidate>
        ${renderField({
          id: 'password',
          label: 'Password',
          error: model.error,
          control: html`<input class="input" id="password" name="password" type="password" autocomplete="current-password" required
            ${model.error !== undefined && html`aria-invalid="true" aria-describedby="password-error"`}>`,
        })}
        <button class="button" type="submit">Sign in</button>
      </form>
    `),
  );
}

export type AdminDashboardModel = {
  readonly donations: readonly Donation[];
  /** Cursor for the next page, or `null` on the last page. */
  readonly nextBeforeId: number | null;
  readonly showUnpaid: boolean;
  readonly overlayUrl: string;
  /** OBS Browser Source for the on-stream table of biggest donations. */
  readonly boardUrl: string;
  /** OBS Browser Sources for the Starting Soon, Be Right Back and Ending Soon scenes. */
  readonly sceneUrls: readonly string[];
  readonly testAlertUrl: string;
  readonly twitch: PlatformStatus;
  readonly kick: PlatformStatus;
  readonly notice?: string;
};

export type PlatformStatus =
  | { readonly state: 'not-configured' }
  | { readonly state: 'disconnected' }
  /** `problem`: what the last daily check found missing; alerts still flow for the rest. */
  | { readonly state: 'connected'; readonly login: string; readonly problem?: string }
  | { readonly state: 'revoked'; readonly login: string; readonly reason: string };

type PlatformSection = {
  /** Shown to the streamer, e.g. "Twitch". */
  readonly name: string;
  /** The admin path segment, e.g. "twitch" for /admin/twitch/connect. */
  readonly path: string;
  /** The .env prefix of its credentials, e.g. "TWITCH". */
  readonly variablePrefix: string;
  /** What it alerts, for the not-configured hint. */
  readonly events: string;
};

const platformSections = {
  twitch: { name: 'Twitch', path: 'twitch', variablePrefix: 'TWITCH', events: 'follows, subs, bits and raids' },
  kick: { name: 'Kick', path: 'kick', variablePrefix: 'KICK', events: 'follows, subs and Kicks' },
} as const satisfies Record<string, PlatformSection>;

/** A platform's section of the dashboard: its status, and the one action that makes sense. */
function renderPlatformStatus(platform: PlatformSection, status: PlatformStatus): SafeHtml {
  switch (status.state) {
    case 'not-configured':
      return html`<p class="muted">Set ${platform.variablePrefix}_CLIENT_ID and ${platform.variablePrefix}_CLIENT_SECRET in .env to show ${platform.events}.</p>`;
    case 'disconnected':
      return html`<p class="muted">Not connected.</p>
        <p><a class="button button--small" href="/admin/${platform.path}/connect">Connect ${platform.name}</a></p>`;
    case 'connected':
      return html`<p>Connected as <strong>${status.login}</strong>.</p>
        ${status.problem !== undefined &&
        html`<p class="field__error">The daily check found some ${platform.name} alerts are no longer set up
            (${status.problem}). Reconnect to fix it.</p>
          <p><a class="button button--small" href="/admin/${platform.path}/connect">Reconnect ${platform.name}</a></p>`}
        <form method="post" action="/admin/${platform.path}/disconnect">
          <button class="button button--ghost button--small" type="submit">Disconnect</button>
        </form>`;
    case 'revoked':
      return html`<p class="field__error">${platform.name} stopped sending events for ${status.login} (${status.reason}).</p>
        <p><a class="button button--small" href="/admin/${platform.path}/connect">Reconnect ${platform.name}</a></p>`;
  }
}

export function renderAdminDashboard(model: AdminDashboardModel): SafeHtml {
  const filterQuery = model.showUnpaid ? '&all=1' : '';
  return layout(
    'Donations',
    panel(html`
      <div class="admin-header">
        <h1 class="panel__heading">Donations</h1>
        <form method="post" action="/admin/logout">
          <button class="button button--ghost" type="submit">Sign out</button>
        </form>
      </div>
      ${model.notice !== undefined && html`<p class="notice" role="status">${model.notice}</p>`}
      <dl class="admin-links">
        <dt>OBS alerts</dt>
        <dd><code>${model.overlayUrl}</code></dd>
        <dt>OBS top-donations table</dt>
        <dd><code>${model.boardUrl}</code></dd>
        <dt>OBS scenes</dt>
        <dd>${model.sceneUrls.map((url) => html`<code>${url}</code><br>`)}</dd>
        <dt>Test alert</dt>
        <dd><a class="link" href="${model.testAlertUrl}">Open the test-alert page</a></dd>
      </dl>
      <p class="footnote">These links contain your overlay token. Keep them off stream.</p>
      <section class="admin-platform" aria-label="Twitch">
        <h2 class="panel__title">Twitch alerts</h2>
        ${renderPlatformStatus(platformSections.twitch, model.twitch)}
      </section>
      <section class="admin-platform" aria-label="Kick">
        <h2 class="panel__title">Kick alerts</h2>
        ${renderPlatformStatus(platformSections.kick, model.kick)}
      </section>
      <nav class="tabs" aria-label="Filter donations">
        ${model.showUnpaid
          ? html`<a class="tabs__tab" href="/admin">Paid only</a><span class="tabs__tab tabs__tab--current" aria-current="page">All, including unpaid</span>`
          : html`<span class="tabs__tab tabs__tab--current" aria-current="page">Paid only</span><a class="tabs__tab" href="/admin?all=1">All, including unpaid</a>`}
      </nav>
      ${model.donations.length === 0
        ? html`<p class="empty-state">${model.showUnpaid ? 'No donations yet.' : 'No paid donations yet. Unpaid checkouts are under "All".'}</p>`
        : html`<ul class="donation-list">${model.donations.map(renderDonationItem)}</ul>`}
      ${model.nextBeforeId !== null &&
      html`<p class="pagination"><a class="link" href="/admin?before=${model.nextBeforeId}${filterQuery}">Older donations</a></p>`}
    `),
    { wide: true },
  );
}

function renderDonationItem(donation: Donation): SafeHtml {
  const alertState =
    donation.alertTriggeredAt === null ? 'No alert' : donation.alertShownAt === null ? 'Alert pending' : 'Alert shown';
  return html`<li class="donation-item">
    <div class="donation-item__header">
      <strong class="donation-item__name">${donation.donorName}</strong>
      <span class="amount">${formatMoneyForDisplay(donation.amountMinor, donation.currency)}</span>
    </div>
    ${donation.message !== '' && html`<p class="donation-item__message">${donation.message}</p>`}
    <p class="donation-item__meta">
      <time datetime="${donation.createdAt}">${formatTimestamp(donation.createdAt)}</time>
      · ${describeStatus(donation)}${donation.payCurrency !== null && html` · ${donation.payCurrency.toUpperCase()}`}
      · ${alertState}${!donation.showOnLeaderboard && html` · Hidden from leaderboard`}${donation.sound !== null &&
      html` · Sound: ${donation.sound.name}`}
    </p>
    ${donation.alertTriggeredAt !== null &&
    html`<div class="donation-item__actions">
      <form method="post" action="/admin/donations/${donation.publicId}/replay">
        <button class="button button--ghost button--small" type="submit">Replay alert</button>
      </form>
      ${donation.alertShownAt === null &&
      html`<form method="post" action="/admin/donations/${donation.publicId}/skip">
        <button class="button button--ghost button--small" type="submit">Skip alert</button>
      </form>`}
    </div>`}
  </li>`;
}

const statusLabels: Readonly<Record<Donation['status'], string>> = {
  created: 'Checkout not started',
  waiting: 'Waiting for payment',
  confirming: 'Confirming',
  confirmed: 'Confirmed',
  sending: 'Paid, settling',
  partially_paid: 'Partially paid',
  finished: 'Paid',
  failed: 'Failed',
  refunded: 'Refunded',
  expired: 'Expired',
};

function describeStatus(donation: Donation): string {
  return statusLabels[donation.status];
}

/** UTC, because the server cannot know the viewer's time zone without client script. */
function formatTimestamp(isoTimestamp: string): string {
  return `${isoTimestamp.slice(0, 16).replace('T', ' ')} UTC`;
}
