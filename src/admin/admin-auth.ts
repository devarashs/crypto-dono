/**
 * The two pieces of admin authentication this service owns. Session handling
 * itself (cookies, signing, ids, regeneration) is @fastify/session's job.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Compares a submitted password with ADMIN_PASSWORD in constant time.
 *
 * Both are hashed first so the comparison runs over equal-length buffers and
 * takes the same time whatever the length of the guess.
 */
export function isCorrectAdminPassword(candidate: string, expected: string): boolean {
  const candidateDigest = createHash('sha256').update(candidate, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

/** 256 bits as hex: well past the 32 characters @fastify/session requires. */
const secretPattern = /^[0-9a-f]{64}$/;

/**
 * Returns the key that signs admin session cookies, creating it on first run.
 *
 * Kept in the data volume rather than in .env, so self-hosters have one less
 * secret to generate. Deleting the file signs every admin out.
 *
 * @param path File to read or create, e.g. next to the database.
 * @throws If the file exists but does not hold a valid secret, rather than
 *   silently replacing it.
 */
export function loadOrCreateSessionSecret(path: string): string {
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (!secretPattern.test(existing)) throw new Error(`${path} does not contain a valid session secret`);
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(dirname(path), { recursive: true });
  const secret = randomBytes(32).toString('hex');
  // "wx" fails if another process created the file in the meantime, and 0600
  // keeps it readable by this user only.
  writeFileSync(path, `${secret}\n`, { flag: 'wx', mode: 0o600 });
  return secret;
}
