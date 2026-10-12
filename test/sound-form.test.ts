import { describe, expect, it } from 'vitest';
import { validateSoundForm } from '../src/soundboard/sound-form.ts';

const sounds = [
  { id: 'airhorn', name: 'Air horn', priceMinor: 250, fileName: 'airhorn.mp3' },
  { id: 'bruh', name: 'Bruh', priceMinor: 100, fileName: 'bruh.mp3' },
];

describe('validateSoundForm', () => {
  it('takes the sound, and so the price, from the list', () => {
    expect(
      validateSoundForm({ soundId: 'bruh', donorName: '  Neon​Rider ', listed: 'on', amount: '0.01', price: '0.01' }, sounds),
    ).toEqual({
      ok: true,
      purchase: { donorName: 'NeonRider', sound: sounds[1], showOnLeaderboard: true },
    });
  });

  it('defaults to Anonymous and to unlisted when the box is unticked', () => {
    expect(validateSoundForm({ soundId: 'airhorn' }, sounds)).toMatchObject({
      ok: true,
      purchase: { donorName: 'Anonymous', showOnLeaderboard: false },
    });
  });

  it.each([
    [{}, 'Pick a sound.'],
    [{ soundId: 'removed' }, 'That sound is no longer available. Pick another.'],
    [{ soundId: ['airhorn', 'bruh'] }, 'Pick a sound.'],
  ])('refuses %j', (body, message) => {
    expect(validateSoundForm(body, sounds)).toMatchObject({ ok: false, errors: { soundId: message } });
  });

  it('refuses a long name and keeps what was typed', () => {
    const result = validateSoundForm({ soundId: 'airhorn', donorName: 'x'.repeat(33), listed: 'on' }, sounds);
    expect(result).toEqual({
      ok: false,
      errors: { donorName: 'Keep your name to 32 characters or fewer.' },
      values: { donorName: 'x'.repeat(33), soundId: 'airhorn', listed: true },
    });
  });
});
