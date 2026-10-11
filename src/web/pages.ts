/**
 * Server-rendered public pages. No client-side JavaScript: the donation flow is
 * a plain form, so it works on any device and loads instantly on mobile data.
 */
import type { DonationFormErrors, DonationFormValues } from '../donations/donation-form.ts';
import { formatMoneyForDisplay } from '../money.ts';
import { html, type SafeHtml } from './html.ts';

function layout(title: string, content: SafeHtml): SafeHtml {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <link rel="stylesheet" href="/static/styles.css">
  </head>
  <body>
    <main class="card">${content}</main>
  </body>
</html>`;
}

export type DonationPageModel = {
  readonly streamerName: string;
  readonly currency: string;
  readonly fractionDigits: number;
  readonly minAmountMinor: number;
  readonly maxAmountMinor: number;
  readonly messageMaxLength: number;
  /** Messages are only shown on stream for donations of at least this much. */
  readonly messageMinAmountMinor: number;
  readonly values?: DonationFormValues;
  readonly errors?: DonationFormErrors;
  /** A one-line message above the form, e.g. after a cancelled payment. */
  readonly notice?: string;
};

export function renderDonationPage(model: DonationPageModel): SafeHtml {
  const errors = model.errors ?? {};
  const values = model.values ?? { donorName: '', amount: '', message: '' };
  const heading = model.streamerName === '' ? 'Support the stream' : `Support ${model.streamerName}`;
  const minimum = formatMoneyForDisplay(model.minAmountMinor, model.currency);

  return layout(
    heading,
    html`
      <h1>${heading}</h1>
      <p class="muted">Your name and message show up on stream once your payment is confirmed.</p>
      ${model.notice !== undefined && html`<p class="notice" role="status">${model.notice}</p>`}
      <form method="post" action="/donate" novalidate>
        ${renderField({
          id: 'donorName',
          label: 'Name',
          optional: true,
          error: errors.donorName,
          control: html`<input id="donorName" name="donorName" autocomplete="nickname"
            value="${values.donorName}" placeholder="Anonymous"${errorAttributes('donorName', errors.donorName)}>`,
        })}
        ${renderField({
          id: 'amount',
          label: 'Amount',
          error: errors.amount,
          hint: errors.amount === undefined ? `Minimum ${minimum}` : undefined,
          control: html`<div class="amount-input">
            <span class="currency" aria-hidden="true">${model.currency}</span>
            <input id="amount" name="amount" inputmode="decimal" required
              value="${values.amount}"${errorAttributes('amount', errors.amount)}>
          </div>`,
        })}
        ${renderField({
          id: 'message',
          label: 'Message',
          optional: true,
          error: errors.message,
          hint: errors.message === undefined ? messageHint(model) : undefined,
          control: html`<textarea id="message" name="message"${errorAttributes('message', errors.message)}>${values.message}</textarea>`,
        })}
        <button type="submit">Continue to payment</button>
      </form>
      <p class="muted footnote">You will choose a coin and pay on NOWPayments' checkout.</p>
    `,
  );
}

/** Tells donors the limits before they type, not after they pay. */
function messageHint(model: DonationPageModel): string {
  const length = `Up to ${model.messageMaxLength} characters.`;
  if (model.messageMinAmountMinor <= model.minAmountMinor) return length;
  return `${length} Shown on stream for donations of ${formatMoneyForDisplay(model.messageMinAmountMinor, model.currency)} or more.`;
}

type FieldModel = {
  readonly id: string;
  readonly label: string;
  readonly optional?: boolean;
  readonly error: string | undefined;
  readonly hint?: string | undefined;
  readonly control: SafeHtml;
};

function renderField(field: FieldModel): SafeHtml {
  return html`<div class="field">
    <label for="${field.id}">${field.label}${field.optional === true && html` <span class="optional">(optional)</span>`}</label>
    ${field.control}
    ${field.hint !== undefined && html`<p class="hint">${field.hint}</p>`}
    ${field.error !== undefined && html`<p class="field-error" id="${field.id}-error">${field.error}</p>`}
  </div>`;
}

/** Links an invalid control to its message so screen readers announce it. */
function errorAttributes(id: string, error: string | undefined): SafeHtml {
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
    html`
      <h1>Thank you${model.donorName !== undefined && html`, ${model.donorName}`}!</h1>
      <p>${amount !== undefined ? html`Your ${amount} donation` : 'Your donation'} will appear on stream once the
        payment is confirmed on the blockchain. That can take from a few seconds to several minutes, depending on the coin.</p>
      <p class="muted"><a href="/">Make another donation</a></p>
    `,
  );
}

export function renderErrorPage(title: string, message: string): SafeHtml {
  return layout(
    title,
    html`
      <h1>${title}</h1>
      <p>${message}</p>
      <p class="muted"><a href="/">Back to the donation page</a></p>
    `,
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
    html`
      <h1>Send a test alert</h1>
      <p class="muted">Shows a fake donation on every connected overlay. Nothing is charged or saved.</p>
      ${model.notice !== undefined && html`<p class="notice" role="status">${model.notice}</p>`}
      <form method="post" action="" novalidate>
        ${renderField({
          id: 'donorName',
          label: 'Name',
          error: errors.donorName,
          control: html`<input id="donorName" name="donorName" value="${model.values.donorName}"${errorAttributes('donorName', errors.donorName)}>`,
        })}
        ${renderField({
          id: 'amount',
          label: 'Amount',
          error: errors.amount,
          control: html`<div class="amount-input">
            <span class="currency" aria-hidden="true">${model.currency}</span>
            <input id="amount" name="amount" inputmode="decimal" value="${model.values.amount}"${errorAttributes('amount', errors.amount)}>
          </div>`,
        })}
        ${renderField({
          id: 'message',
          label: 'Message',
          optional: true,
          error: errors.message,
          control: html`<textarea id="message" name="message"${errorAttributes('message', errors.message)}>${model.values.message}</textarea>`,
        })}
        <button type="submit">Send test alert</button>
      </form>
    `,
  );
}
