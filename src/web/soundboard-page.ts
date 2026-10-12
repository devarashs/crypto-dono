/**
 * The public soundboard page: a grid of sound pads, cheapest first. Pick one,
 * give a name, pay.
 *
 * Choosing and paying are a plain form, so they work without JavaScript. The
 * small preview button on each pad needs public/sound-preview.js, which unhides
 * it; without the script there is simply no preview.
 */
import { formatMoneyForDisplay } from '../money.ts';
import type { SoundFormErrors, SoundFormValues } from '../soundboard/sound-form.ts';
import type { Sound } from '../soundboard/soundboard.ts';
import { html, type SafeHtml } from './html.ts';
import { errorAttributes, glitchTitle, layout, panel, renderField } from './pages.ts';

export type SoundboardPageModel = {
  readonly streamerName: string;
  readonly currency: string;
  /** In display order. */
  readonly sounds: readonly Sound[];
  /** Whether to offer the leaderboard opt-out (LEADERBOARD on). */
  readonly leaderboardEnabled: boolean;
  readonly values?: SoundFormValues;
  readonly errors?: SoundFormErrors;
  /** A one-line message above the form, e.g. after a cancelled payment. */
  readonly notice?: string;
};

/** Cheapest first; sounds at the same price keep the streamer's order. */
export function soundsByPrice(sounds: readonly Sound[]): readonly Sound[] {
  return [...sounds].sort((first, second) => first.priceMinor - second.priceMinor);
}

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
        <ul class="sound-pads">
          ${model.sounds.map((sound) => renderSoundPad(sound, model.currency, sound.id === values.soundId))}
        </ul>
        ${errors.soundId !== undefined && html`<p class="field__error" id="soundId-error">${errors.soundId}</p>`}
      </fieldset>
      <div class="sound-checkout">
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
      </div>
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
    { wide: true, script: '/static/sound-preview.js' },
  );
}

/**
 * One pad: the whole pad selects the sound; the corner button previews it. The
 * button sits outside the <label>, so previewing does not also select.
 */
function renderSoundPad(sound: Sound, currency: string, checked: boolean): SafeHtml {
  const inputId = `sound-${sound.id}`;
  return html`<li class="sound-pad">
    <label class="sound-pad__choice" for="${inputId}">
      <input class="sound-pad__input" type="radio" name="soundId" id="${inputId}" value="${sound.id}"${checked && html` checked`}>
      <span class="sound-pad__name">${sound.name}</span>
      <span class="sound-pad__price amount">${formatMoneyForDisplay(sound.priceMinor, currency)}</span>
    </label>
    <button class="sound-pad__preview" type="button" data-preview="/sounds/${sound.id}/audio"
      aria-label="Preview ${sound.name}" aria-pressed="false" hidden></button>
  </li>`;
}
