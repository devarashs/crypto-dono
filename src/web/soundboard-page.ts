/**
 * The public soundboard page: pick a sound, give a name, pay.
 *
 * Script-free like the other public pages. Previews are native <audio>
 * controls, kept outside each option's <label> so pressing play does not
 * also select the sound.
 */
import { formatMoneyForDisplay } from '../money.ts';
import type { SoundFormErrors, SoundFormValues } from '../soundboard/sound-form.ts';
import type { Sound } from '../soundboard/soundboard.ts';
import { html, type SafeHtml } from './html.ts';
import { errorAttributes, glitchTitle, layout, panel, renderField } from './pages.ts';

export type SoundboardPageModel = {
  readonly streamerName: string;
  readonly currency: string;
  readonly sounds: readonly Sound[];
  /** Whether to offer the leaderboard opt-out (LEADERBOARD on). */
  readonly leaderboardEnabled: boolean;
  readonly values?: SoundFormValues;
  readonly errors?: SoundFormErrors;
  /** A one-line message above the form, e.g. after a cancelled payment. */
  readonly notice?: string;
};

export function renderSoundboardPage(model: SoundboardPageModel): SafeHtml {
  const errors = model.errors ?? {};
  // Listing is opt-out, as on the donation page.
  const values = model.values ?? { donorName: '', soundId: '', listed: true };
  // A short heading: the display font is wide, and a long name would break mid-word.
  const title = model.streamerName === '' ? 'Soundboard' : `${model.streamerName}'s soundboard`;

  const form = html`
    <h2 class="panel__title">Play a sound</h2>
    ${model.notice !== undefined && html`<p class="notice" role="status">${model.notice}</p>`}
    <form class="form" method="post" action="/sounds" novalidate>
      <fieldset class="field sound-picker"${errors.soundId !== undefined && html` aria-describedby="soundId-error"`}>
        <legend class="field__label">Sound</legend>
        <ul class="sound-list">
          ${model.sounds.map((sound) => renderSoundOption(sound, model.currency, sound.id === values.soundId))}
        </ul>
        ${errors.soundId !== undefined && html`<p class="field__error" id="soundId-error">${errors.soundId}</p>`}
      </fieldset>
      ${renderField({
        id: 'donorName',
        label: 'Name',
        optional: true,
        error: errors.donorName,
        hint: errors.donorName === undefined ? 'Shown on stream with the sound.' : undefined,
        control: html`<input class="input" id="donorName" name="donorName" autocomplete="nickname"
          value="${values.donorName}" placeholder="Anonymous"${errorAttributes('donorName', errors.donorName)}>`,
      })}
      ${model.leaderboardEnabled &&
      html`<label class="checkbox">
        <input class="checkbox__input" type="checkbox" name="listed"${values.listed && html` checked`}>
        <span class="checkbox__box" aria-hidden="true"></span>
        <span class="checkbox__label">Show me on the public leaderboard
          <span class="checkbox__hint">Your name and the amount.</span></span>
      </label>`}
      <button class="button" type="submit">Continue to payment</button>
    </form>
    <p class="footnote">You pay the listed price on NOWPayments' checkout. <a class="link" href="/">Donate instead</a></p>
  `;

  return layout(
    title,
    html`
      <header class="hero rise-in">
        ${glitchTitle('Soundboard')}
        <p class="hero__tagline">Pick a sound. It plays on stream once your payment confirms.</p>
      </header>
      ${panel(form, { className: 'panel--sounds', label: 'Soundboard' })}
    `,
  );
}

function renderSoundOption(sound: Sound, currency: string, checked: boolean): SafeHtml {
  const inputId = `sound-${sound.id}`;
  return html`<li class="sound-option">
    <label class="sound-option__choice" for="${inputId}">
      <input class="sound-option__input" type="radio" name="soundId" id="${inputId}" value="${sound.id}"${checked && html` checked`}>
      <span class="sound-option__name">${sound.name}</span>
      <span class="sound-option__price amount">${formatMoneyForDisplay(sound.priceMinor, currency)}</span>
    </label>
    <audio class="sound-option__preview" controls preload="none" src="/sounds/${sound.id}/audio" aria-label="Preview ${sound.name}"></audio>
  </li>`;
}
