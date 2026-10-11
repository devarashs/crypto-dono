import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

const minimalEnvironment = {
  PUBLIC_BASE_URL: 'https://dono.example.com',
  NOWPAYMENTS_API_KEY: 'test-api-key',
  NOWPAYMENTS_IPN_SECRET: 'test-ipn-secret',
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
      donation: { currency: 'usd', fractionDigits: 2, minAmountMinor: 100, maxAmountMinor: 100000 },
    });
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
    expect(issues).toHaveLength(5);
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
      ).toEqual({ currency: 'jpy', fractionDigits: 0, minAmountMinor: 300, maxAmountMinor: 100000 });
    });

    it('accepts equal minimum and maximum', () => {
      expect(
        loadConfig({ ...minimalEnvironment, DONATION_MIN_AMOUNT: '5', DONATION_MAX_AMOUNT: '5' }).donation,
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
});
