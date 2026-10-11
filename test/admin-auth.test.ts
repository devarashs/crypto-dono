import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCorrectAdminPassword, loadOrCreateSessionSecret } from '../src/admin/admin-auth.ts';

describe('isCorrectAdminPassword', () => {
  it.each([
    ['the exact password', 'correct horse battery', true],
    ['a different password', 'wrong horse battery', false],
    ['a prefix', 'correct horse', false],
    ['a longer string', 'correct horse battery!', false],
    ['different case', 'Correct horse battery', false],
    ['empty', '', false],
  ])('%s → %s', (_label, candidate, expected) => {
    expect(isCorrectAdminPassword(candidate, 'correct horse battery')).toBe(expected);
  });

  it('handles non-ASCII passwords', () => {
    expect(isCorrectAdminPassword('pässwörd-日本語-1234', 'pässwörd-日本語-1234')).toBe(true);
  });
});

describe('loadOrCreateSessionSecret', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'crypto-dono-secret-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('creates a 256-bit hex secret on first run, in a missing folder', () => {
    const path = join(directory, 'nested', 'session-secret');
    const secret = loadOrCreateSessionSecret(path);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path, 'utf8').trim()).toBe(secret);
  });

  it('returns the same secret on later runs', () => {
    const path = join(directory, 'session-secret');
    expect(loadOrCreateSessionSecret(path)).toBe(loadOrCreateSessionSecret(path));
  });

  it('creates a different secret for a different installation', () => {
    expect(loadOrCreateSessionSecret(join(directory, 'a'))).not.toBe(loadOrCreateSessionSecret(join(directory, 'b')));
  });

  it('refuses to replace a corrupted secret file', () => {
    const path = join(directory, 'session-secret');
    writeFileSync(path, 'not a secret');
    expect(() => loadOrCreateSessionSecret(path)).toThrow('does not contain a valid session secret');
    expect(readFileSync(path, 'utf8')).toBe('not a secret');
  });
});
