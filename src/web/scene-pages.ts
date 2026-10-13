/**
 * Full-screen stream scenes (Starting Soon, Be Right Back, Ending Soon), each
 * an OBS Browser Source of 1920 × 1080. The page is static; scene.js fills the
 * donor lists from a feed, runs the optional countdown, and shows chat and the
 * viewer count from the overlay's live stream.
 */
import { html, type SafeHtml } from './html.ts';
import { backdrop, glitchTitle } from './pages.ts';
import type { SocialLinkModel } from './social-links.ts';

export const sceneKinds = ['starting-soon', 'brb', 'ending-soon'] as const;
export type SceneKind = (typeof sceneKinds)[number];

const sceneCopy: Readonly<Record<SceneKind, { title: string; subtitle: string }>> = {
  'starting-soon': { title: 'Starting soon', subtitle: 'Grab a drink. The stream starts shortly.' },
  brb: { title: 'Be right back', subtitle: 'Stretching, refilling, back in a moment.' },
  'ending-soon': { title: 'Ending soon', subtitle: 'Thanks for hanging out. See you next stream.' },
};

export type ScenePageModel = {
  readonly kind: SceneKind;
  readonly streamerName: string;
  /** The donation page address as shown on screen, e.g. "dono.example.com". */
  readonly donateDisplay: string;
  readonly socialLinks: readonly SocialLinkModel[];
};

export function renderScenePage(model: ScenePageModel): SafeHtml {
  const copy = sceneCopy[model.kind];
  // Paths are relative to /overlay/<token>/scene/<kind>, so the token never
  // appears in the page.
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${copy.title}</title>
    <link rel="preload" href="/fonts/orbitron-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/static/scene.css">
    <script src="/static/scene.js" type="module"></script>
  </head>
  <body class="scene scene--${model.kind}" data-feed-url="feed.json" data-refresh-ms="15000" data-stream-url="../live"
    data-countdown="${model.kind === 'starting-soon' ? 'on' : 'off'}">
    ${backdrop()}
    <main class="scene__stage">
      <header class="scene__header rise-in">
        ${model.streamerName !== '' && html`<p class="scene__streamer">${model.streamerName}</p>`}
        ${glitchTitle(copy.title)}
        <p class="scene__subtitle">${copy.subtitle}</p>
        <div class="viewer-pill scene__viewers" id="viewers" hidden></div>
        <p class="scene__countdown" id="countdown" hidden></p>
      </header>

      <div class="scene__panels">
        <section class="scene-panel scene-panel--donate rise-in" aria-label="Donate">
          <h2 class="scene-panel__title">Support the stream</h2>
          <div class="scene-qr">
            <img class="scene-qr__code" src="qr.svg" width="240" height="240" alt="QR code for ${model.donateDisplay}">
          </div>
          <p class="scene-donate__url">${model.donateDisplay}</p>
          <p class="scene-donate__hint">Scan or type it. Crypto, any coin.</p>
        </section>

        <section class="scene-panel rise-in" aria-label="Top donors">
          <h2 class="scene-panel__title">Top donors</h2>
          <ol class="scene-list" id="top-donors"></ol>
          <p class="scene-list__empty" id="top-donors-empty" hidden>Be the first.</p>
        </section>

        <section class="scene-panel rise-in" aria-label="Latest donations">
          <h2 class="scene-panel__title">Latest donations</h2>
          <ol class="scene-list" id="latest"></ol>
          <p class="scene-list__empty" id="latest-empty" hidden>No donations yet.</p>
        </section>
      </div>

      <section class="scene-panel scene-panel--chat rise-in" aria-label="Chat">
        <h2 class="scene-panel__title">Chat</h2>
        <ol class="stream-chat scene-chat" id="chat" aria-live="off"></ol>
      </section>

      ${model.socialLinks.length > 0 &&
      html`<footer class="scene__socials rise-in">
        <ul class="scene-socials">${model.socialLinks.map(
          (link) => html`<li class="scene-socials__item">
            <svg class="scene-socials__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${link.iconPath}"></path></svg>
            <span class="scene-socials__handle">${link.display}</span>
          </li>`,
        )}</ul>
      </footer>`}
    </main>
  </body>
</html>`;
}
