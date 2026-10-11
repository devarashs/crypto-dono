import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

const minimalEnvironment = { PUBLIC_BASE_URL: 'https://dono.example.com' };

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
    });
  });

  it('reads explicit values', () => {
    const config = loadConfig({
      ...minimalEnvironment,
      HOST: '127.0.0.1',
      PORT: '8080',
      LOG_LEVEL: 'debug',
      DATABASE_PATH: '/var/lib/dono.sqlite',
    });
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 8080,
      logLevel: 'debug',
      databasePath: '/var/lib/dono.sqlite',
    });
  });

  it('strips trailing slashes from PUBLIC_BASE_URL', () => {
    expect(loadConfig({ PUBLIC_BASE_URL: 'https://dono.example.com//' }).publicBaseUrl).toBe(
      'https://dono.example.com',
    );
  });

  it('accepts a plain http URL for local development', () => {
    expect(loadConfig({ PUBLIC_BASE_URL: 'http://localhost:3000' }).publicBaseUrl).toBe(
      'http://localhost:3000',
    );
  });

  it('treats empty strings as unset so defaults apply', () => {
    expect(loadConfig({ ...minimalEnvironment, PORT: '', HOST: '' })).toMatchObject({
      host: '0.0.0.0',
      port: 3000,
    });
  });

  it('reports a missing required variable by name', () => {
    expect(configErrorFor({}).issues).toEqual(['PUBLIC_BASE_URL is required but not set']);
  });

  it('reports an empty required variable as missing', () => {
    expect(configErrorFor({ PUBLIC_BASE_URL: '' }).issues).toEqual([
      'PUBLIC_BASE_URL is required but not set',
    ]);
  });

  it.each([
    ['not a url', 'not-a-url'],
    ['a non-http scheme', 'ftp://dono.example.com'],
  ])('rejects PUBLIC_BASE_URL that is %s', (_label, value) => {
    const issues = configErrorFor({ PUBLIC_BASE_URL: value }).issues;
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

  it('reports every problem at once', () => {
    const issues = configErrorFor({ PORT: 'abc', LOG_LEVEL: 'verbose' }).issues;
    expect(issues).toHaveLength(3);
    expect(issues.join('\n')).toContain('PUBLIC_BASE_URL is required');
  });

  it('puts every issue in the error message', () => {
    const error = configErrorFor({ PORT: 'abc' });
    for (const issue of error.issues) expect(error.message).toContain(issue);
  });
});
