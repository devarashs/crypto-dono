/**
 * Turns a platform event into an overlay alert: the streamer's wording for its
 * kind, banned words masked, the platform's icon, and the kind's sound. The one
 * place event alerts are built, whichever platform sent the event.
 */
import type { OverlayAlert, EventSoundCue } from '../alerts/alert-hub.ts';
import type { BannedWordFilter } from '../alerts/banned-words.ts';
import { renderHeadline } from '../alerts/headline.ts';
import type { AlertSound } from '../config.ts';
import { socialIcons } from '../web/social-icons.ts';
import { switchFor, type StreamEvent, type StreamEventKind, type SwitchableEventKind } from './stream-event.ts';

export type EventPresenterSettings = {
  readonly enabled: ReadonlySet<SwitchableEventKind>;
  readonly durationMs: number;
  readonly templates: Readonly<Record<StreamEventKind, string>>;
  readonly sounds: Readonly<Record<SwitchableEventKind, AlertSound>>;
};

/** Returns the alert, or `null` when the streamer has switched this kind off. */
export type EventPresenter = (event: StreamEvent, alertId: string) => OverlayAlert | null;

/** Numbers are highlighted in the headline, like donation amounts. */
const emphasisedValues = new Set(['months', 'count', 'bits', 'kicks', 'viewers']);

export function createEventPresenter(settings: EventPresenterSettings, bannedWords: BannedWordFilter): EventPresenter {
  return (event, alertId) => {
    const switchKind = switchFor(event.kind);
    if (!settings.enabled.has(switchKind)) return null;

    const actorName = bannedWords.mask(event.actorName);
    const count = event.count ?? 1;
    const values: Record<string, string> = {
      name: actorName,
      months: formatNumber(event.months ?? 0),
      count: formatNumber(count),
      subs: count === 1 ? 'sub' : 'subs',
      bits: formatNumber(event.bits ?? 0),
      kicks: formatNumber(event.kicks ?? 0),
      viewers: formatNumber(event.viewers ?? 0),
    };
    const icon = event.platform === 'test' ? undefined : socialIcons[event.platform];

    return {
      id: alertId,
      kind: event.kind,
      headline: renderHeadline(settings.templates[event.kind], values, emphasisedValues),
      donorName: actorName,
      message: event.message === undefined ? '' : bannedWords.mask(event.message),
      amount: '',
      speak: false,
      ...(icon !== undefined && { badge: { label: icon.title, iconPath: icon.path } }),
      sound: soundCue(switchKind, settings.sounds[switchKind]),
      durationMs: settings.durationMs,
    };
  };
}

function soundCue(kind: SwitchableEventKind, sound: AlertSound): EventSoundCue {
  if (sound.kind === 'none') return { type: 'none' };
  // Served by the overlay routes; relative to the overlay's events URL.
  if (sound.kind === 'file') return { type: 'file', path: `assets/sound/${kind}` };
  return { type: 'tone', tone: kind };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en').format(value);
}
