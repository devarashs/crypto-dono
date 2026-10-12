import { describe, expect, it } from 'vitest';
import { createBannedWordFilter } from '../src/alerts/banned-words.ts';
import { headlineText } from '../src/alerts/headline.ts';
import { createEventPresenter, type EventPresenterSettings } from '../src/events/event-presenter.ts';
import { defaultEventTemplates, type StreamEvent } from '../src/events/stream-event.ts';

const settings: EventPresenterSettings = {
  enabled: new Set(['follow', 'sub', 'gift', 'cheer', 'raid']),
  durationMs: 6000,
  templates: defaultEventTemplates,
  sounds: {
    follow: { kind: 'chime' },
    sub: { kind: 'chime' },
    gift: { kind: 'chime' },
    cheer: { kind: 'none' },
    raid: { kind: 'file', fileName: 'raid.mp3' },
  },
};
const present = createEventPresenter(settings, createBannedWordFilter(['darn']));
const twitch = (event: Omit<StreamEvent, 'platform'>): StreamEvent => ({ platform: 'twitch', ...event });

describe('createEventPresenter', () => {
  it('builds a follow alert with the Twitch badge and the kind tone', () => {
    const alert = present(twitch({ kind: 'follow', actorName: 'NeonRider' }), 'e1');
    expect(alert).toMatchObject({
      id: 'e1',
      kind: 'follow',
      donorName: 'NeonRider',
      message: '',
      speak: false,
      badge: { label: 'Twitch' },
      sound: { type: 'tone', tone: 'follow' },
      durationMs: 6000,
    });
    expect(headlineText(alert?.headline ?? [])).toBe('NeonRider just followed');
  });

  it.each([
    [{ kind: 'sub', actorName: 'Ann' }, 'Ann subscribed'],
    [{ kind: 'resub', actorName: 'Ann', months: 14, message: 'love it' }, 'Ann resubscribed for 14 months'],
    [{ kind: 'gift', actorName: 'Bo', count: 1 }, 'Bo gifted 1 sub'],
    [{ kind: 'gift', actorName: 'Bo', count: 25 }, 'Bo gifted 25 subs'],
    [{ kind: 'cheer', actorName: 'Cy', bits: 1500 }, 'Cy cheered 1,500 bits'],
    [{ kind: 'kicks', actorName: 'Ky', kicks: 1000 }, 'Ky sent 1,000 Kicks'],
    [{ kind: 'resub', actorName: 'Re' }, 'Re resubscribed'],
    [{ kind: 'raid', actorName: 'BigStreamer', viewers: 1234 }, 'BigStreamer is raiding with 1,234 viewers'],
  ] as const)('words %j as %j', (event, text) => {
    expect(headlineText(present(twitch(event), 'e')?.headline ?? [])).toBe(text);
  });

  it('highlights the numbers only', () => {
    expect(present(twitch({ kind: 'cheer', actorName: 'Cy', bits: 500 }), 'e')?.headline).toEqual([
      { text: 'Cy cheered ', emphasis: false },
      { text: '500', emphasis: true },
      { text: ' bits', emphasis: false },
    ]);
  });

  it('masks banned words in the name and the message', () => {
    expect(present(twitch({ kind: 'resub', actorName: 'DarnDave darn', months: 2, message: 'darn good' }), 'e')).toMatchObject({
      donorName: 'DarnDave ****',
      message: '**** good',
    });
  });

  it('returns null for a kind that is switched off; resubs follow the sub switch', () => {
    const subsOff = createEventPresenter({ ...settings, enabled: new Set(['follow']) }, createBannedWordFilter([]));
    expect(subsOff(twitch({ kind: 'sub', actorName: 'A' }), 'e')).toBeNull();
    expect(subsOff(twitch({ kind: 'resub', actorName: 'A', months: 3 }), 'e')).toBeNull();
    expect(subsOff(twitch({ kind: 'follow', actorName: 'A' }), 'e')).not.toBeNull();
  });

  it('uses silence or a custom file per kind, and the sub sound for resubs', () => {
    expect(present(twitch({ kind: 'cheer', actorName: 'A', bits: 1 }), 'e')?.sound).toEqual({ type: 'none' });
    expect(present(twitch({ kind: 'raid', actorName: 'A', viewers: 1 }), 'e')?.sound).toEqual({
      type: 'file',
      path: 'assets/sound/raid',
    });
    expect(present(twitch({ kind: 'resub', actorName: 'A', months: 2 }), 'e')?.sound).toEqual({ type: 'tone', tone: 'sub' });
  });

  it('shows the Kick badge for Kick, and no badge for a platformless test', () => {
    expect(present({ platform: 'kick', kind: 'follow', actorName: 'A' }, 'e')?.badge?.label).toBe('Kick');
    expect(present({ platform: 'test', kind: 'follow', actorName: 'A' }, 'e')?.badge).toBeUndefined();
  });

  it('applies custom wording', () => {
    const custom = createEventPresenter(
      { ...settings, templates: { ...defaultEventTemplates, follow: 'Welcome aboard, {name}!' } },
      createBannedWordFilter([]),
    );
    expect(headlineText(custom(twitch({ kind: 'follow', actorName: 'Ann' }), 'e')?.headline ?? [])).toBe('Welcome aboard, Ann!');
  });
});
