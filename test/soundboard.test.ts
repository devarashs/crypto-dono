import { describe, expect, it } from 'vitest';
import { maximumSounds, parseSoundboard } from '../src/soundboard/soundboard.ts';

const rules = { fractionDigits: 2, minAmountMinor: 100, maxAmountMinor: 100_000 };
const parse = (data: unknown) => parseSoundboard(JSON.stringify(data), rules);

describe('parseSoundboard', () => {
  it('reads sounds in file order, prices as strings or numbers', () => {
    expect(
      parse([
        { id: 'airhorn', name: ' Air horn ', price: '2.50', file: 'airhorn.mp3' },
        { id: 'bruh', name: 'Bruh', price: 1, file: 'bruh.ogg' },
      ]),
    ).toEqual({
      sounds: [
        { id: 'airhorn', name: 'Air horn', priceMinor: 250, fileName: 'airhorn.mp3' },
        { id: 'bruh', name: 'Bruh', priceMinor: 100, fileName: 'bruh.ogg' },
      ],
      issues: [],
    });
  });

  it.each([
    ['not JSON', '{oops', /^not valid JSON/],
    ['an object', '{"airhorn": 2}', /must be a JSON list/],
    ['an empty list', '[]', /lists no sounds; delete the file/],
  ])('explains a file that is %s', (_label, text, issue) => {
    expect(parseSoundboard(text, rules).issues).toEqual([expect.stringMatching(issue)]);
  });

  it(`refuses more than ${maximumSounds} sounds`, () => {
    const many = Array.from({ length: maximumSounds + 1 }, (_, index) => ({ id: `s${index}`, name: 'S', price: 1, file: 's.mp3' }));
    expect(parse(many).issues).toEqual([`lists ${maximumSounds + 1} sounds; at most ${maximumSounds}`]);
  });

  it('accepts ids made from file names, with capitals and underscores', () => {
    const result = parse([{ id: 'nya_2xyALFL', name: 'Nya', price: 1, file: 'nya_2xyALFL.mp3' }]);
    expect(result.issues).toEqual([]);
    expect(result.sounds.map((sound) => sound.id)).toEqual(['nya_2xyALFL']);
  });

  it('names every bad entry at once, and keeps the good ones', () => {
    const result = parse([
      { id: 'Air Horn', name: 'Air horn', price: 2, file: 'a.mp3' },
      { id: 'ok', name: 'Fine', price: 2, file: 'ok.mp3' },
      { id: 'ok', name: 'Again', price: 2, file: 'again.mp3' },
      { id: 'cheap', name: 'Cheap', price: '0.50', file: 'c.mp3' },
      { id: 'pricey', name: 'Pricey', price: 5000, file: 'p.mp3' },
      { id: 'odd', name: 'Odd', price: '1.234', file: 'o.mp3' },
      { id: 'extra', name: 'Extra', price: 2, file: 'e.mp3', volume: 3 },
      { id: 'noname', name: '  ', price: 2, file: 'n.mp3' },
      'airhorn',
    ]);
    expect(result.sounds.map((sound) => sound.id)).toEqual(['ok', 'ok']);
    expect(result.issues).toEqual([
      expect.stringMatching(/^sound 1 \("Air Horn"\): id: id must be 1 to 64 letters, digits, dashes or underscores/),
      'sound 3 ("ok"): the id "ok" is used more than once',
      'sound 4 ("cheap"): price must be an amount between DONATION_MIN_AMOUNT and DONATION_MAX_AMOUNT',
      'sound 5 ("pricey"): price must be an amount between DONATION_MIN_AMOUNT and DONATION_MAX_AMOUNT',
      'sound 6 ("odd"): price must be an amount between DONATION_MIN_AMOUNT and DONATION_MAX_AMOUNT',
      expect.stringMatching(/^sound 7 \("extra"\): .*volume/),
      'sound 8 ("noname"): name: name must not be empty',
      expect.stringMatching(/^sound 9: /),
    ]);
  });
});
