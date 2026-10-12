import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

const minimalEnvironment = {
  PUBLIC_BASE_URL: 'https://dono.example.com',
  NOWPAYMENTS_API_KEY: 'test-api-key',
  NOWPAYMENTS_IPN_SECRET: 'test-ipn-secret',
  OVERLAY_TOKEN: 'overlay-token-for-tests-0123456789',
};

function configErrorFor(environment: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(environment);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected loadConfig to throw ConfigError');
}

describe('loadConfig', () => {
  it('applies defaults when only required variables are set', () => {
    expect(loadConfig(minimalEnvironment)).toEqual({
      host: '0.0.0.0',
      port: 3000,
      logLevel: 'info',
      publicBaseUrl: 'https://dono.example.com',
      databasePath: 'data/crypto-dono.sqlite',
      streamerName: '',
      nowPayments: {
        apiKey: 'test-api-key',
        ipnSecret: 'test-ipn-secret',
        baseUrl: 'https://api.nowpayments.io/v1',
        sandbox: false,
      },
      alertOnStatus: 'confirmed',
      overlayToken: 'overlay-token-for-tests-0123456789',
      alert: {
        durationMs: 8000,
        textTemplate: '{name} donated {amount}',
        assetsDirectory: resolve('custom'),
        sound: { kind: 'chime' },
        imageFileName: null,
      },
      socialLinks: [],
      twitch: null,
      leaderboardEnabled: true,
      adminPassword: null,
      filters: { messageMaxLength: 300, bannedWords: [], messageMinAmountMinor: 0, speechMinAmountMinor: 0 },
      events: {
        enabled: new Set(['follow', 'sub', 'gift', 'cheer', 'raid']),
        durationMs: 6000,
        templates: {
          follow: '{name} just followed',
          sub: '{name} subscribed',
          resub: '{name} resubscribed for {months} months',
          gift: '{name} gifted {count} {subs}',
          cheer: '{name} cheered {bits} bits',
          raid: '{name} is raiding with {viewers} viewers',
        },
        sounds: {
          follow: { kind: 'chime' },
          sub: { kind: 'chime' },
          gift: { kind: 'chime' },
          cheer: { kind: 'chime' },
          raid: { kind: 'chime' },
        },
      },
      soundboard: null,
      soundboardIssues: [],
      tts: null,
      donation: {
        currency: 'usd',
        fractionDigits: 2,
        minAmountMinor: 100,
        maxAmountMinor: 100000,
        presetsMinor: [500, 1000, 2500, 5000, 10000],
      },
    });
  });

  describe('DONATION_PRESETS', () => {
    it('parses, de-duplicates and sorts the amounts', () => {
      expect(
        loadConfig({ ...minimalEnvironment, DONATION_PRESETS: ' 20, 2.50 ,20,,100 ' }).donation.presetsMinor,
      ).toEqual([250, 2000, 10000]);
    });

    it.each(['none', 'NONE'])('%s means no chips', (value) => {
      expect(loadConfig({ ...minimalEnvironment, DONATION_PRESETS: value }).donation.presetsMinor).toEqual([]);
    });

    it.each([
      ['a malformed amount', '5,ten', /"ten" is not/],
      ['zero', '0,5', /"0" is not/],
      ['too many decimals', '5.555', /"5.555" is not/],
      ['more than 8 amounts', '1,2,3,4,5,6,7,8,9', /at most 8/],
      ['an amount below the minimum', '0.5,5', /between DONATION_MIN_AMOUNT and DONATION_MAX_AMOUNT/],
      ['an amount above the maximum', '5,5000', /between DONATION_MIN_AMOUNT and DONATION_MAX_AMOUNT/],
    ])('rejects %s', (_label, value, pattern) => {
      const issues = configErrorFor({ ...minimalEnvironment, DONATION_PRESETS: value }).issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(pattern);
    });

    it('trims unset defaults to the amount range instead of failing', () => {
      expect(
        loadConfig({ ...minimalEnvironment, DONATION_MIN_AMOUNT: '20', DONATION_MAX_AMOUNT: '60' }).donation.presetsMinor,
      ).toEqual([2500, 5000]);
    });

    it('uses the currency decimals', () => {
      expect(
        loadConfig({
          ...minimalEnvironment,
          DONATION_CURRENCY: 'jpy',
          DONATION_MIN_AMOUNT: '100',
          DONATION_MAX_AMOUNT: '100000',
          DONATION_PRESETS: '500,1000',
        }).donation.presetsMinor,
      ).toEqual([500, 1000]);
    });
  });

  it.each(['short', 'has spaces in it but is long enough', 'x'.repeat(23), 'a/b'.repeat(10)])(
    'rejects OVERLAY_TOKEN=%j and explains how to generate one',
    (token) => {
      const issue = configErrorFor({ ...minimalEnvironment, OVERLAY_TOKEN: token }).issues[0];
      expect(issue).toMatch(/^OVERLAY_TOKEN: .*randomBytes/);
    },
  );

  it('accepts a 24-character base64url OVERLAY_TOKEN', () => {
    expect(loadConfig({ ...minimalEnvironment, OVERLAY_TOKEN: 'aB3_-'.repeat(5).slice(0, 24) }).overlayToken).toHaveLength(24);
  });

  it.each(['confirming', 'confirmed', 'finished'])('accepts ALERT_ON_STATUS=%s', (status) => {
    expect(loadConfig({ ...minimalEnvironment, ALERT_ON_STATUS: status }).alertOnStatus).toBe(status);
  });

  it.each(['waiting', 'partially_paid', 'FINISHED', 'done'])('rejects ALERT_ON_STATUS=%s', (status) => {
    expect(configErrorFor({ ...minimalEnvironment, ALERT_ON_STATUS: status }).issues[0]).toMatch(
      /^ALERT_ON_STATUS: /,
    );
  });

  it('reads explicit values', () => {
    const config = loadConfig({
      ...minimalEnvironment,
      HOST: '127.0.0.1',
      PORT: '8080',
      LOG_LEVEL: 'debug',
      DATABASE_PATH: '/var/lib/dono.sqlite',
      STREAMER_NAME: '  Arash  ',
    });
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 8080,
      logLevel: 'debug',
      databasePath: '/var/lib/dono.sqlite',
      streamerName: 'Arash',
    });
  });

  it('strips trailing slashes from PUBLIC_BASE_URL', () => {
    expect(
      loadConfig({ ...minimalEnvironment, PUBLIC_BASE_URL: 'https://dono.example.com//' }).publicBaseUrl,
    ).toBe('https://dono.example.com');
  });

  it('accepts a plain http URL for local development', () => {
    expect(
      loadConfig({ ...minimalEnvironment, PUBLIC_BASE_URL: 'http://localhost:3000' }).publicBaseUrl,
    ).toBe('http://localhost:3000');
  });

  it('treats empty strings as unset so defaults apply', () => {
    expect(loadConfig({ ...minimalEnvironment, PORT: '', HOST: '' })).toMatchObject({
      host: '0.0.0.0',
      port: 3000,
    });
  });

  it('reports missing required variables by name', () => {
    expect(configErrorFor({}).issues).toEqual([
      'PUBLIC_BASE_URL is required but not set',
      'NOWPAYMENTS_API_KEY is required but not set',
      'NOWPAYMENTS_IPN_SECRET is required but not set',
      'OVERLAY_TOKEN is required but not set',
    ]);
  });

  it('reports an empty required variable as missing', () => {
    expect(configErrorFor({ ...minimalEnvironment, PUBLIC_BASE_URL: '' }).issues).toEqual([
      'PUBLIC_BASE_URL is required but not set',
    ]);
  });

  it('rejects a whitespace-only API key', () => {
    expect(configErrorFor({ ...minimalEnvironment, NOWPAYMENTS_API_KEY: '   ' }).issues[0]).toMatch(
      /^NOWPAYMENTS_API_KEY: /,
    );
  });

  it.each([
    ['not a url', 'not-a-url'],
    ['a non-http scheme', 'ftp://dono.example.com'],
  ])('rejects PUBLIC_BASE_URL that is %s', (_label, value) => {
    const issues = configErrorFor({ ...minimalEnvironment, PUBLIC_BASE_URL: value }).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^PUBLIC_BASE_URL: /);
  });

  it.each(['0', '65536', '3000.5', 'abc', '-1'])('rejects PORT=%s', (port) => {
    const issues = configErrorFor({ ...minimalEnvironment, PORT: port }).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^PORT: /);
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expect(configErrorFor({ ...minimalEnvironment, LOG_LEVEL: 'verbose' }).issues[0]).toMatch(
      /^LOG_LEVEL: /,
    );
  });

  it('rejects a STREAMER_NAME over 60 characters', () => {
    expect(
      configErrorFor({ ...minimalEnvironment, STREAMER_NAME: 'x'.repeat(61) }).issues[0],
    ).toMatch(/^STREAMER_NAME: /);
  });

  it('reports every problem at once', () => {
    const issues = configErrorFor({ PORT: 'abc', LOG_LEVEL: 'verbose' }).issues;
    expect(issues).toHaveLength(6);
    expect(issues.join('\n')).toContain('PUBLIC_BASE_URL is required');
    expect(issues.join('\n')).toContain('NOWPAYMENTS_API_KEY is required');
  });

  it('puts every issue in the error message', () => {
    const error = configErrorFor({ PORT: 'abc' });
    for (const issue of error.issues) expect(error.message).toContain(issue);
  });

  describe('NOWPAYMENTS_SANDBOX', () => {
    it.each(['true', '1', 'yes', 'on'])('%s selects the sandbox API', (value) => {
      expect(loadConfig({ ...minimalEnvironment, NOWPAYMENTS_SANDBOX: value }).nowPayments).toMatchObject({
        sandbox: true,
        baseUrl: 'https://api-sandbox.nowpayments.io/v1',
      });
    });

    it.each(['false', '0', 'no', 'off'])('%s selects production', (value) => {
      expect(loadConfig({ ...minimalEnvironment, NOWPAYMENTS_SANDBOX: value }).nowPayments.sandbox).toBe(false);
    });

    it('rejects an ambiguous value instead of guessing', () => {
      expect(configErrorFor({ ...minimalEnvironment, NOWPAYMENTS_SANDBOX: 'maybe' }).issues[0]).toMatch(
        /^NOWPAYMENTS_SANDBOX: /,
      );
    });
  });

  describe('donation currency and amounts', () => {
    it('normalises the currency to lower case', () => {
      expect(loadConfig({ ...minimalEnvironment, DONATION_CURRENCY: 'EUR' }).donation.currency).toBe('eur');
    });

    it('rejects an unknown currency', () => {
      expect(configErrorFor({ ...minimalEnvironment, DONATION_CURRENCY: 'dollars' }).issues[0]).toMatch(
        /^DONATION_CURRENCY: must be an ISO 4217/,
      );
    });

    it('converts amounts using the currency decimals', () => {
      expect(
        loadConfig({
          ...minimalEnvironment,
          DONATION_MIN_AMOUNT: '2.50',
          DONATION_MAX_AMOUNT: '500',
        }).donation,
      ).toMatchObject({ minAmountMinor: 250, maxAmountMinor: 50000 });
      expect(
        loadConfig({
          ...minimalEnvironment,
          DONATION_CURRENCY: 'jpy',
          DONATION_MIN_AMOUNT: '300',
          DONATION_MAX_AMOUNT: '100000',
        }).donation,
      ).toEqual({
        currency: 'jpy',
        fractionDigits: 0,
        minAmountMinor: 300,
        maxAmountMinor: 100000,
        // The defaults, 5 to 100 yen, all fall below this minimum.
        presetsMinor: [],
      });
    });

    it('accepts equal minimum and maximum', () => {
      expect(
        loadConfig({ ...minimalEnvironment, DONATION_MIN_AMOUNT: '5', DONATION_MAX_AMOUNT: '5', DONATION_PRESETS: '5' })
          .donation,
      ).toMatchObject({ minAmountMinor: 500, maxAmountMinor: 500 });
    });

    it.each(['0', '0.00', 'abc', '-1', '1.234'])('rejects DONATION_MIN_AMOUNT=%s', (value) => {
      expect(configErrorFor({ ...minimalEnvironment, DONATION_MIN_AMOUNT: value }).issues).toEqual([
        expect.stringMatching(/^DONATION_MIN_AMOUNT: /),
      ]);
    });

    it('rejects decimals a zero-decimal currency cannot represent', () => {
      expect(
        configErrorFor({ ...minimalEnvironment, DONATION_CURRENCY: 'jpy', DONATION_MIN_AMOUNT: '1.5' }).issues[0],
      ).toMatch(/^DONATION_MIN_AMOUNT: .*at most 0 decimals/);
    });

    it('rejects a maximum below the minimum', () => {
      expect(
        configErrorFor({ ...minimalEnvironment, DONATION_MIN_AMOUNT: '10', DONATION_MAX_AMOUNT: '5' }).issues,
      ).toEqual(['DONATION_MAX_AMOUNT: must not be below DONATION_MIN_AMOUNT']);
    });

    it('reports both amounts when both are malformed', () => {
      expect(
        configErrorFor({ ...minimalEnvironment, DONATION_MIN_AMOUNT: 'x', DONATION_MAX_AMOUNT: 'y' }).issues,
      ).toHaveLength(2);
    });
  });

  it.each([
    ['off', false],
    ['false', false],
    ['on', true],
  ])('reads LEADERBOARD=%s', (value, enabled) => {
    expect(loadConfig({ ...minimalEnvironment, LEADERBOARD: value }).leaderboardEnabled).toBe(enabled);
  });

  describe('event alerts', () => {
    it('switches kinds on and off with EVENT_ALERTS', () => {
      expect([...loadConfig({ ...minimalEnvironment, EVENT_ALERTS: ' Sub , raid ' }).events.enabled]).toEqual(['sub', 'raid']);
      expect(loadConfig({ ...minimalEnvironment, EVENT_ALERTS: 'none' }).events.enabled.size).toBe(0);
    });

    it('rejects an unknown kind, naming the valid ones', () => {
      expect(configErrorFor({ ...minimalEnvironment, EVENT_ALERTS: 'follow,donation' }).issues).toEqual([
        'EVENT_ALERTS: unknown kind "donation". Use follow, sub, gift, cheer, raid, or none',
      ]);
    });

    it('reads custom wording and duration', () => {
      const events = loadConfig({
        ...minimalEnvironment,
        EVENT_TEMPLATE_FOLLOW: ' Welcome, {name}! ',
        EVENT_DURATION_SECONDS: '4',
      }).events;
      expect(events.templates.follow).toBe('Welcome, {name}!');
      expect(events.templates.raid).toBe('{name} is raiding with {viewers} viewers');
      expect(events.durationMs).toBe(4000);
    });

    it('reads per-kind sounds, checking files like ALERT_SOUND', () => {
      const existing = new Set([resolve('custom', 'raid.mp3')]);
      const events = loadConfig(
        { ...minimalEnvironment, EVENT_SOUND_RAID: 'raid.mp3', EVENT_SOUND_FOLLOW: 'none' },
        (path) => existing.has(path),
      ).events;
      expect(events.sounds.raid).toEqual({ kind: 'file', fileName: 'raid.mp3' });
      expect(events.sounds.follow).toEqual({ kind: 'none' });
      expect(configErrorFor({ ...minimalEnvironment, EVENT_SOUND_SUB: 'missing.mp3' }).issues[0]).toMatch(
        /^EVENT_SOUND_SUB: no file named "missing.mp3"/,
      );
    });
  });

  describe('Twitch credentials', () => {
    it('reads both together', () => {
      expect(
        loadConfig({ ...minimalEnvironment, TWITCH_CLIENT_ID: 'abc123xyz', TWITCH_CLIENT_SECRET: 'secret456' }).twitch,
      ).toEqual({ clientId: 'abc123xyz', clientSecret: 'secret456' });
    });

    it.each([
      ['only the id', { TWITCH_CLIENT_ID: 'abc123xyz' }],
      ['only the secret', { TWITCH_CLIENT_SECRET: 'secret456' }],
    ])('rejects %s', (_label, overrides) => {
      expect(configErrorFor({ ...minimalEnvironment, ...overrides }).issues).toEqual([
        'TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET: set both, or neither',
      ]);
    });

    it('rejects a client id that is not Twitch-shaped, such as a leftover placeholder', () => {
      expect(
        configErrorFor({ ...minimalEnvironment, TWITCH_CLIENT_ID: '...', TWITCH_CLIENT_SECRET: 'x' }).issues[0],
      ).toMatch(/^TWITCH_CLIENT_ID: should be the Client ID/);
    });
  });

  describe('SOCIAL_LINKS', () => {
    it('parses platform=url pairs in order, case-insensitive platform', () => {
      expect(
        loadConfig({
          ...minimalEnvironment,
          SOCIAL_LINKS: ' Twitch=https://www.twitch.tv/me , kick=https://kick.com/me,link=https://me.example/blog?a=1 ',
        }).socialLinks,
      ).toEqual([
        { platform: 'twitch', url: 'https://www.twitch.tv/me' },
        { platform: 'kick', url: 'https://kick.com/me' },
        { platform: 'link', url: 'https://me.example/blog?a=1' },
      ]);
    });

    it.each([
      ['an unknown platform', 'myspace=https://myspace.com/me', /unknown platform "myspace"/],
      ['a missing url', 'twitch=', /should look like platform=https/],
      ['no separator', 'https://twitch.tv/me', /should look like platform=https/],
      ['plain http', 'twitch=http://twitch.tv/me', /must be a full https/],
      ['a javascript: url', 'link=javascript:alert(1)', /must be a full https/],
      ['a relative url', 'link=/about', /must be a full https/],
    ])('rejects %s', (_label, value, pattern) => {
      const issues = configErrorFor({ ...minimalEnvironment, SOCIAL_LINKS: value }).issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(pattern);
    });

    it('caps the strip at 10 links', () => {
      const links = Array.from({ length: 11 }, (_unused, index) => `link=https://e${index}.example`).join(',');
      expect(configErrorFor({ ...minimalEnvironment, SOCIAL_LINKS: links }).issues).toEqual(['SOCIAL_LINKS: at most 10 links']);
    });
  });

  describe('ADMIN_PASSWORD', () => {
    it('keeps the password exactly, including surrounding spaces', () => {
      expect(loadConfig({ ...minimalEnvironment, ADMIN_PASSWORD: ' twelve chars ' }).adminPassword).toBe(' twelve chars ');
    });

    it('rejects a password under 12 characters, without echoing it', () => {
      const issues = configErrorFor({ ...minimalEnvironment, ADMIN_PASSWORD: 'short-pass1' }).issues;
      expect(issues).toEqual(['ADMIN_PASSWORD: must be at least 12 characters']);
    });
  });

  describe('message filters', () => {
    it('splits BANNED_WORDS on commas, trimming and dropping empties', () => {
      expect(
        loadConfig({ ...minimalEnvironment, BANNED_WORDS: ' darn, heck no ,, ,fudge ' }).filters.bannedWords,
      ).toEqual(['darn', 'heck no', 'fudge']);
    });

    it('converts the minimum amounts with the currency decimals', () => {
      expect(
        loadConfig({ ...minimalEnvironment, MESSAGE_MIN_AMOUNT: '2.50', TTS_MIN_AMOUNT: '10' }).filters,
      ).toMatchObject({ messageMinAmountMinor: 250, speechMinAmountMinor: 1000 });
    });

    it.each([
      ['MESSAGE_MIN_AMOUNT', 'abc'],
      ['TTS_MIN_AMOUNT', '-1'],
      ['TTS_MIN_AMOUNT', '1.234'],
    ])('rejects %s=%s', (variable, value) => {
      expect(configErrorFor({ ...minimalEnvironment, [variable]: value }).issues).toEqual([
        expect.stringMatching(new RegExp(`^${variable}: `)),
      ]);
    });

    it.each(['9', '501', 'long'])('rejects MESSAGE_MAX_LENGTH=%s', (value) => {
      expect(configErrorFor({ ...minimalEnvironment, MESSAGE_MAX_LENGTH: value }).issues[0]).toMatch(
        /^MESSAGE_MAX_LENGTH: /,
      );
    });
  });

  describe('text-to-speech', () => {
    it('is off without TTS_URL, even with a template', () => {
      expect(loadConfig({ ...minimalEnvironment, TTS_TEMPLATE: '{message}' }).tts).toBeNull();
    });

    it('reads the URL without a trailing slash and the default template', () => {
      expect(loadConfig({ ...minimalEnvironment, TTS_URL: 'http://piper:5000/' }).tts).toEqual({
        url: 'http://piper:5000',
        template: '{name} donated {amount}. {message}',
      });
    });

    it('reads a custom template', () => {
      expect(
        loadConfig({ ...minimalEnvironment, TTS_URL: 'http://piper:5000', TTS_TEMPLATE: ' {name} says {message} ' }).tts
          ?.template,
      ).toBe('{name} says {message}');
    });

    it.each(['piper:5000', 'ftp://piper', 'not a url'])('rejects TTS_URL=%s', (url) => {
      expect(configErrorFor({ ...minimalEnvironment, TTS_URL: url }).issues[0]).toMatch(/^TTS_URL: /);
    });
  });

  describe('soundboard', () => {
    const soundboardPath = resolve('custom', 'soundboard.json');
    const load = (files: Record<string, string>, existing: readonly string[], overrides: Record<string, string> = {}) =>
      loadConfig(
        { ...minimalEnvironment, ...overrides },
        (path) => existing.map((name) => resolve('custom', name)).includes(path),
        (path) => files[path],
      );
    const issuesFor = (...args: Parameters<typeof load>) => {
      try {
        load(...args);
      } catch (error) {
        if (error instanceof ConfigError) return error.issues;
        throw error;
      }
      throw new Error('expected a ConfigError');
    };

    it('is off without a soundboard.json', () => {
      expect(load({}, []).soundboard).toBeNull();
    });

    it('reads the sounds from soundboard.json in CUSTOM_ASSETS_DIR', () => {
      const json = JSON.stringify([{ id: 'airhorn', name: 'Air horn', price: '2.50', file: 'airhorn.mp3' }]);
      expect(load({ [soundboardPath]: json }, ['airhorn.mp3']).soundboard).toEqual([
        { id: 'airhorn', name: 'Air horn', priceMinor: 250, fileName: 'airhorn.mp3' },
      ]);
    });

    it('prices sounds in the donation currency and its range', () => {
      const json = JSON.stringify([{ id: 'horn', name: 'Horn', price: 300, file: 'horn.mp3' }]);
      expect(load({ [soundboardPath]: json }, ['horn.mp3'], { DONATION_CURRENCY: 'jpy', DONATION_MIN_AMOUNT: '100', DONATION_MAX_AMOUNT: '5000' }).soundboard).toEqual([
        { id: 'horn', name: 'Horn', priceMinor: 300, fileName: 'horn.mp3' },
      ]);
    });

    it('turns the soundboard off over a missing, misnamed or non-audio file, naming the sound', () => {
      const json = JSON.stringify([
        { id: 'gone', name: 'Gone', price: 2, file: 'gone.mp3' },
        { id: 'escape', name: 'Escape', price: 2, file: '../secret.mp3' },
        { id: 'picture', name: 'Picture', price: 2, file: 'cat.png' },
      ]);
      const config = load({ [soundboardPath]: json }, ['cat.png']);
      expect(config.soundboard).toBeNull();
      expect(config.soundboardIssues).toEqual([
        `sound "gone" file: no file named "gone.mp3" in ${resolve('custom')}`,
        'sound "escape" file: must be a plain file name inside CUSTOM_ASSETS_DIR, without folders',
        'sound "picture" file: must end in one of .mp3, .ogg, .wav, .m4a',
      ]);
    });

    it('keeps the rest of the service running when the file is broken', () => {
      const config = load({ [soundboardPath]: '[]' }, []);
      expect(config.soundboard).toBeNull();
      expect(config.soundboardIssues).toEqual(['lists no sounds; delete the file to turn the soundboard off']);
    });

    it('turns the whole soundboard off over one bad entry, so a problem is noticed', () => {
      const json = JSON.stringify([
        { id: 'good', name: 'Good', price: 2, file: 'good.mp3' },
        { id: 'bad id', name: 'Bad', price: 2, file: 'good.mp3' },
      ]);
      const config = load({ [soundboardPath]: json }, ['good.mp3']);
      expect(config.soundboard).toBeNull();
      expect(config.soundboardIssues).toEqual([expect.stringMatching(/^sound 2 \("bad id"\): id: /)]);
    });

    it('still stops the service over other configuration problems', () => {
      expect(issuesFor({}, [], { SOCIAL_LINKS: 'nope' })).toEqual([expect.stringMatching(/^SOCIAL_LINKS: /)]);
    });
  });

  describe('alert customisation', () => {
    const existing = new Set([resolve('custom', 'cash.mp3'), resolve('custom', 'party.gif'), resolve('/srv/assets', 'ding.ogg')]);
    const fileExists = (path: string) => existing.has(path);
    const load = (overrides: Record<string, string>) => loadConfig({ ...minimalEnvironment, ...overrides }, fileExists);
    const issuesFor = (overrides: Record<string, string>) => {
      try {
        load(overrides);
      } catch (error) {
        if (error instanceof ConfigError) return error.issues;
        throw error;
      }
      throw new Error('expected a ConfigError');
    };

    it('reads duration, template, sound and image', () => {
      expect(
        load({
          ALERT_DURATION_SECONDS: '12',
          ALERT_TEXT_TEMPLATE: '  {amount} from {name}!  ',
          ALERT_SOUND: 'cash.mp3',
          ALERT_IMAGE: 'party.gif',
        }).alert,
      ).toEqual({
        durationMs: 12000,
        textTemplate: '{amount} from {name}!',
        assetsDirectory: resolve('custom'),
        sound: { kind: 'file', fileName: 'cash.mp3' },
        imageFileName: 'party.gif',
      });
    });

    it('resolves files against CUSTOM_ASSETS_DIR', () => {
      expect(load({ CUSTOM_ASSETS_DIR: '/srv/assets', ALERT_SOUND: 'ding.ogg' }).alert).toMatchObject({
        assetsDirectory: resolve('/srv/assets'),
        sound: { kind: 'file', fileName: 'ding.ogg' },
      });
    });

    it.each(['none', 'NONE', 'None'])('treats ALERT_SOUND=%s as silent', (value) => {
      expect(load({ ALERT_SOUND: value }).alert.sound).toEqual({ kind: 'none' });
    });

    it.each(['1', '61', '2.5', 'eight'])('rejects ALERT_DURATION_SECONDS=%s', (value) => {
      expect(issuesFor({ ALERT_DURATION_SECONDS: value })[0]).toMatch(/^ALERT_DURATION_SECONDS: /);
    });

    it('rejects a template over 120 characters', () => {
      expect(issuesFor({ ALERT_TEXT_TEMPLATE: 'x'.repeat(121) })[0]).toMatch(/^ALERT_TEXT_TEMPLATE: /);
    });

    it('names a missing file and the folder it looked in', () => {
      expect(issuesFor({ ALERT_SOUND: 'missing.mp3' })).toEqual([
        `ALERT_SOUND: no file named "missing.mp3" in ${resolve('custom')}`,
      ]);
    });

    it.each(['../secrets.mp3', 'sub/cash.mp3', 'sub\\cash.mp3', '/etc/cash.mp3', '.hidden.mp3', 'C:cash.mp3'])(
      'refuses %j, which is not a plain file name',
      (value) => {
        expect(issuesFor({ ALERT_SOUND: value })[0]).toMatch(/^ALERT_SOUND: must be a plain file name/);
      },
    );

    it.each([
      ['ALERT_SOUND', 'party.gif', /must end in one of .mp3/],
      ['ALERT_IMAGE', 'cash.mp3', /must end in one of .gif/],
      ['ALERT_IMAGE', 'page.svg', /must end in one of/],
    ])('refuses %s=%s with the wrong file type', (variable, value, pattern) => {
      expect(issuesFor({ [variable]: value })[0]).toMatch(pattern);
    });

    it('reports problems with both files together', () => {
      expect(issuesFor({ ALERT_SOUND: 'a.mp3', ALERT_IMAGE: 'b.gif' })).toHaveLength(2);
    });
  });
});
