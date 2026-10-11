/**
 * Server-rendered public pages. No client-side JavaScript: the donation flow is
 * a plain form, so it works on any device and loads instantly on mobile data.
 */
import { customAmountChip, type DonationFormErrors, type DonationFormValues } from '../donations/donation-form.ts';
import { formatMoneyForDisplay, parseAmountToMinorUnits } from '../money.ts';
import { html, type SafeHtml } from './html.ts';
import type { SocialLinkModel } from './social-links.ts';

/**
 * The page shell: a fixed neon backdrop (grid floor, horizon bloom, scanlines,
 * all CSS) behind a centred column.
 *
 * @param options.wide A wider column, for the donation page with its
 *   leaderboard and for the admin history.
 */
export function layout(title: string, content: SafeHtml, options: { wide?: boolean } = {}): SafeHtml {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#0b0817">
    <title>${title}</title>
    <link rel="preload" href="/fonts/orbitron-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/static/styles.css">
  </head>
  <body>
    ${backdrop()}
    <main class="page${options.wide === true ? ' page--wide' : ''}">${content}</main>
  </body>
</html>`;
}

/**
 * The neon scene behind a page: sky, horizon bloom, rolling grid and scanlines.
 * Decorative, CSS only (effects.css); shared with the stream scenes.
 */
export function backdrop(): SafeHtml {
  return html`<div class="backdrop" aria-hidden="true">
      <div class="backdrop__bloom"></div>
      <div class="backdrop__floor"><div class="backdrop__grid"></div></div>
      <div class="backdrop__horizon-fade"></div>
    </div>
    <div class="scanlines" aria-hidden="true"></div>`;
}

/** A content surface with neon corner brackets. */
export function panel(content: SafeHtml, options: { className?: string; label?: string } = {}): SafeHtml {
  const className = options.className === undefined ? 'panel rise-in' : `panel rise-in ${options.className}`;
  return options.label === undefined
    ? html`<section class="${className}">${content}</section>`
    : html`<section class="${className}" aria-label="${options.label}">${content}</section>`;
}

/**
 * A heading with a brief RGB-split glitch on load and on hover. The two copies
 * are aria-hidden, so the heading is announced once.
 */
export function glitchTitle(text: string): SafeHtml {
  return html`<h1 class="glitch-title">
    <span class="glitch-title__text">${text}</span>
    <span class="glitch-title__slice glitch-title__slice--upper" aria-hidden="true">${text}</span>
    <span class="glitch-title__slice glitch-title__slice--lower" aria-hidden="true">${text}</span>
  </h1>`;
}

export type DonationPageModel = {
  readonly streamerName: string;
  readonly currency: string;
  readonly fractionDigits: number;
  readonly minAmountMinor: number;
  readonly maxAmountMinor: number;
  /** One-tap amounts; empty shows a plain amount field instead of chips. */
  readonly presets: readonly AmountPreset[];
  readonly messageMaxLength: number;
  /** Messages are only shown on stream for donations of at least this much. */
  readonly messageMinAmountMinor: number;
  readonly values?: DonationFormValues;
  readonly errors?: DonationFormErrors;
  /** A one-line message above the form, e.g. after a cancelled payment. */
  readonly notice?: string;
  /** The public leaderboard, or `null` when LEADERBOARD is off. */
  readonly leaderboard: LeaderboardModel | null;
  /** The quiet strip of profile links under the page; empty for none. */
  readonly socialLinks: readonly SocialLinkModel[];
};

export type { SocialLinkModel } from './social-links.ts';

export type LeaderboardModel = {
  readonly currency: string;
  /** Names already masked for banned words. */
  readonly topDonors: readonly { donorName: string; totalMinor: number; lastDonatedAt: string }[];
  readonly recent: readonly { donorName: string; amountMinor: number; donatedAt: string }[];
};

export type AmountPreset = {
  /** Plain decimal submitted with the form, e.g. "10.00". */
  readonly value: string;
  /** Shown on the chip, e.g. "$10.00". */
  readonly label: string;
};

export function renderDonationPage(model: DonationPageModel): SafeHtml {
  const errors = model.errors ?? {};
  // A fresh form starts with the leaderboard box ticked: listing is opt-out.
  const values = model.values ?? { donorName: '', amount: '', message: '', listed: true };
  const heading = model.streamerName === '' ? 'Support the stream' : `Support ${model.streamerName}`;
  const minimum = formatMoneyForDisplay(model.minAmountMinor, model.currency);

  const form = html`
    <h2 class="panel__title">Donate</h2>
    ${model.notice !== undefined && html`<p class="notice" role="status">${model.notice}</p>`}
    <form class="form" method="post" action="/donate" novalidate>
      ${renderField({
        id: 'donorName',
        label: 'Name',
        optional: true,
        error: errors.donorName,
        control: html`<input class="input" id="donorName" name="donorName" autocomplete="nickname"
          value="${values.donorName}" placeholder="Anonymous"${errorAttributes('donorName', errors.donorName)}>`,
      })}
      ${model.presets.length === 0
        ? renderField({
            id: 'amount',
            label: 'Amount',
            error: errors.amount,
            hint: errors.amount === undefined ? `Minimum ${minimum}` : undefined,
            control: amountInput(model.currency, values.amount, errors.amount, true),
          })
        : renderAmountPicker(model, values.amount, errors.amount, minimum)}
      ${renderField({
        id: 'message',
        label: 'Message',
        optional: true,
        error: errors.message,
        hint: errors.message === undefined ? messageHint(model) : undefined,
        control: html`<textarea class="input input--multiline" id="message" name="message"${errorAttributes('message', errors.message)}>${values.message}</textarea>`,
      })}
      ${model.leaderboard !== null &&
      html`<label class="checkbox">
        <input class="checkbox__input" type="checkbox" name="listed"${values.listed && html` checked`}>
        <span class="checkbox__box" aria-hidden="true"></span>
        <span class="checkbox__label">Show me on the public leaderboard
          <span class="checkbox__hint">Name and amount only, never your message.</span></span>
      </label>`}
      <button class="button" type="submit">Continue to payment</button>
    </form>
    <p class="footnote">You pick a coin and pay on NOWPayments' checkout.</p>
  `;

  return layout(
    heading,
    html`
      <header class="hero rise-in">
        ${glitchTitle(heading)}
        <p class="hero__tagline">Your name and message hit the stream once your payment confirms.</p>
      </header>
      <div class="donate-layout">
        ${panel(form, { className: 'panel--donate', label: 'Donate' })}
        ${model.leaderboard !== null && panel(renderLeaderboard(model.leaderboard), { className: 'panel--board', label: 'Leaderboard' })}
      </div>
      ${model.socialLinks.length > 0 && renderSocialLinks(model.socialLinks)}
    `,
    { wide: true },
  );
}

/**
 * Preset amounts as a radio group of chips, plus a Custom chip that reveals the
 * free amount field (CSS only, see styles.css). After a validation error the
 * chip matching the submitted amount is selected again, or Custom with the
 * amount filled in.
 */
function renderAmountPicker(
  model: DonationPageModel,
  amount: string,
  error: string | undefined,
  minimum: string,
): SafeHtml {
  const amountMinor = parseAmountToMinorUnits(amount, model.fractionDigits);
  const selectedPreset = model.presets.find(
    (preset) => amountMinor !== undefined && parseAmountToMinorUnits(preset.value, model.fractionDigits) === amountMinor,
  );
  const customSelected = selectedPreset === undefined && amount.trim() !== '';
  const chip = (value: string, label: string, checked: boolean) => html`<label class="chip">
      <input class="chip__input" type="radio" name="preset" value="${value}"${checked && html` checked`}>
      <span class="chip__face">${label}</span>
    </label>`;

  return html`<fieldset class="field amount-picker"${error !== undefined && html` aria-describedby="amount-error"`}>
    <legend class="field__label">Amount</legend>
    <div class="chips">
      ${model.presets.map((preset) => chip(preset.value, preset.label, preset === selectedPreset))}
      ${chip(customAmountChip, 'Custom', customSelected)}
    </div>
    <div class="amount-custom">
      <label class="visually-hidden" for="amount">Custom amount</label>
      ${amountInput(model.currency, customSelected ? amount : '', error, false)}
    </div>
    ${error === undefined
      ? html`<p class="field__hint">Minimum ${minimum}</p>`
      : html`<p class="field__error" id="amount-error">${error}</p>`}
  </fieldset>`;
}

/**
 * Two views, "Top 100 donors" and "Recent", switched by a pair of radio buttons
 * and CSS (see styles.css): no JavaScript, and no reload that would wipe a
 * half-filled donation form.
 */
function renderLeaderboard(board: LeaderboardModel): SafeHtml {
  const money = (amountMinor: number) => formatMoneyForDisplay(amountMinor, board.currency);
  const empty = html`<p class="empty-state">No donors yet. Be the first.</p>`;

  const topTable =
    board.topDonors.length === 0
      ? empty
      : html`<table class="board-table">
          <caption class="visually-hidden">Top donors by total donated</caption>
          <thead><tr>
            <th scope="col" class="board-table__rank">#</th>
            <th scope="col">Donor</th>
            <th scope="col" class="board-table__number">Total</th>
            <th scope="col" class="board-table__date">Latest</th>
          </tr></thead>
          <tbody>${board.topDonors.map(
            (donor, index) => html`<tr class="board-table__row${index < 3 ? ` board-table__row--top-${index + 1}` : ''}">
              <td class="board-table__rank">${index + 1}</td>
              <td class="board-table__name">${donor.donorName}</td>
              <td class="board-table__number">${money(donor.totalMinor)}</td>
              <td class="board-table__date"><time datetime="${donor.lastDonatedAt}">${formatDate(donor.lastDonatedAt)}</time></td>
            </tr>`,
          )}</tbody>
        </table>`;

  const recentTable =
    board.recent.length === 0
      ? empty
      : html`<table class="board-table">
          <caption class="visually-hidden">Most recent donations</caption>
          <thead><tr>
            <th scope="col">Donor</th>
            <th scope="col" class="board-table__number">Amount</th>
            <th scope="col" class="board-table__date">Date</th>
          </tr></thead>
          <tbody>${board.recent.map(
            (donation) => html`<tr class="board-table__row">
              <td class="board-table__name">${donation.donorName}</td>
              <td class="board-table__number">${money(donation.amountMinor)}</td>
              <td class="board-table__date"><time datetime="${donation.donatedAt}">${formatDate(donation.donatedAt)}</time></td>
            </tr>`,
          )}</tbody>
        </table>`;

  return html`
    <h2 class="panel__title">Leaderboard</h2>
    <div class="board">
      <input class="board__toggle visually-hidden" type="radio" name="board-view" id="board-top" checked>
      <input class="board__toggle visually-hidden" type="radio" name="board-view" id="board-recent">
      <div class="tabs">
        <label class="tabs__tab" for="board-top">Top 100 donors</label>
        <label class="tabs__tab" for="board-recent">Recent</label>
      </div>
      <div class="board__view board__view--top" tabindex="0" aria-label="Top 100 donors">${topTable}</div>
      <div class="board__view board__view--recent" tabindex="0" aria-label="Recent donations">${recentTable}</div>
    </div>
  `;
}

/**
 * Deliberately quiet: small muted icons after the main content, so the page's
 * attention stays on donating. rel="me" marks them as the streamer's own
 * profiles, which some platforms use to verify the link back.
 */
function renderSocialLinks(links: readonly SocialLinkModel[]): SafeHtml {
  return html`<nav class="socials rise-in" aria-label="Find me elsewhere">
    <ul class="socials__list">${links.map(
      (link) => html`<li><a class="socials__link" href="${link.url}" rel="me noopener" aria-label="${link.label}" title="${link.label}">
        <svg class="socials__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${link.iconPath}"></path></svg>
      </a></li>`,
    )}</ul>
  </nav>`;
}

/** "Oct 11, 2026", in UTC: the server cannot know the viewer's time zone. */
function formatDate(isoTimestamp: string): string {
  return new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(isoTimestamp),
  );
}

/** Amount field with the currency code as a prefix. */
function amountInput(currency: string, value: string, error: string | undefined, required: boolean): SafeHtml {
  return html`<div class="amount-input">
    <span class="amount-input__currency" aria-hidden="true">${currency}</span>
    <input class="amount-input__field" id="amount" name="amount" inputmode="decimal"${required && html` required`}
      value="${value}"${errorAttributes('amount', error)}>
  </div>`;
}

/** Tells donors the limits before they type, not after they pay. */
function messageHint(model: DonationPageModel): string {
  const length = `Up to ${model.messageMaxLength} characters.`;
  if (model.messageMinAmountMinor <= model.minAmountMinor) return length;
  return `${length} Shown on stream for donations of ${formatMoneyForDisplay(model.messageMinAmountMinor, model.currency)} or more.`;
}

export type FieldModel = {
  readonly id: string;
  readonly label: string;
  readonly optional?: boolean;
  readonly error: string | undefined;
  readonly hint?: string | undefined;
  readonly control: SafeHtml;
};

export function renderField(field: FieldModel): SafeHtml {
  return html`<div class="field">
    <label class="field__label" for="${field.id}">${field.label}${field.optional === true && html` <span class="field__optional">optional</span>`}</label>
    ${field.control}
    ${field.hint !== undefined && html`<p class="field__hint">${field.hint}</p>`}
    ${field.error !== undefined && html`<p class="field__error" id="${field.id}-error">${field.error}</p>`}
  </div>`;
}

/** Links an invalid control to its message so screen readers announce it. */
export function errorAttributes(id: string, error: string | undefined): SafeHtml {
  return error === undefined ? html`` : html` aria-invalid="true" aria-describedby="${id}-error"`;
}

export type ThanksPageModel = {
  readonly donorName?: string;
  readonly amountMinor?: number;
  readonly currency?: string;
};

export function renderThanksPage(model: ThanksPageModel): SafeHtml {
  const amount =
    model.amountMinor !== undefined && model.currency !== undefined
      ? formatMoneyForDisplay(model.amountMinor, model.currency)
      : undefined;
  return layout(
    'Thank you',
    panel(html`
      <h1 class="panel__heading">Thank you${model.donorName !== undefined && html`, ${model.donorName}`}!</h1>
      <p>${amount !== undefined ? html`Your <strong class="amount">${amount}</strong> donation` : 'Your donation'} will
        appear on stream once the payment is confirmed on the blockchain. That takes from a few seconds to several
        minutes, depending on the coin.</p>
      <p class="panel__footer"><a class="link" href="/">Make another donation</a></p>
    `),
  );
}

export function renderErrorPage(title: string, message: string): SafeHtml {
  return layout(
    title,
    panel(html`
      <h1 class="panel__heading">${title}</h1>
      <p>${message}</p>
      <p class="panel__footer"><a class="link" href="/">Back to the donation page</a></p>
    `),
  );
}

export type TestAlertPageModel = {
  readonly currency: string;
  readonly values: DonationFormValues;
  readonly errors?: DonationFormErrors;
  /** Result of the last send, e.g. "Sent to 1 overlay." */
  readonly notice?: string;
};

/**
 * Lets the streamer fire a fake alert at connected overlays, to set up OBS
 * without making a payment. Served under the overlay token, never linked publicly.
 */
export function renderTestAlertPage(model: TestAlertPageModel): SafeHtml {
  const errors = model.errors ?? {};
  return layout(
    'Send a test alert',
    panel(html`
      <h1 class="panel__heading">Test alert</h1>
      <p class="muted">Shows a fake donation on every connected overlay. Nothing is charged or saved.</p>
      ${model.notice !== undefined && html`<p class="notice" role="status">${model.notice}</p>`}
      <form class="form" method="post" action="" novalidate>
        ${renderField({
          id: 'donorName',
          label: 'Name',
          error: errors.donorName,
          control: html`<input class="input" id="donorName" name="donorName" value="${model.values.donorName}"${errorAttributes('donorName', errors.donorName)}>`,
        })}
        ${renderField({
          id: 'amount',
          label: 'Amount',
          error: errors.amount,
          control: amountInput(model.currency, model.values.amount, errors.amount, false),
        })}
        ${renderField({
          id: 'message',
          label: 'Message',
          optional: true,
          error: errors.message,
          control: html`<textarea class="input input--multiline" id="message" name="message"${errorAttributes('message', errors.message)}>${model.values.message}</textarea>`,
        })}
        <button class="button" type="submit">Send test alert</button>
      </form>
    `),
  );
}
