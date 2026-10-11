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
  readonly testAlertUrl: string;
  readonly notice?: string;
};

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
        <dt>OBS Browser Source</dt>
        <dd><code>${model.overlayUrl}</code></dd>
        <dt>Test alert</dt>
        <dd><a class="link" href="${model.testAlertUrl}">Open the test-alert page</a></dd>
      </dl>
      <p class="footnote">Both links contain your overlay token. Keep them off stream.</p>
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
      · ${alertState}
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
