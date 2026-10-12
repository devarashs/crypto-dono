/**
 * Kick's webhook signing key, fetched from Kick rather than hard-coded: the docs
 * say it "can be rotated at any time".
 *
 * Kept in memory once fetched. When a signature fails, the caller asks for a
 * fresh copy and tries once more, which picks up a rotated key; refreshes are
 * throttled so a stream of forged requests cannot make this server hammer Kick.
 */
import { z } from 'zod';

export const kickPublicKeyUrl = 'https://api.kick.com/public/v1/public-key';

/** At most one refresh in this window. */
const refreshIntervalMs = 5 * 60 * 1000;
const requestTimeoutMs = 10_000;

const responseSchema = z.object({ data: z.object({ public_key: z.string().startsWith('-----BEGIN PUBLIC KEY-----') }) });

export type KickPublicKeySource = {
  /** The key, fetched on first use. @throws If Kick cannot be reached. */
  current(): Promise<string>;
  /**
   * Fetches the key again, unless it was fetched recently.
   * @returns The new key, or `null` when throttled or Kick could not be reached.
   */
  refresh(): Promise<string | null>;
};

export function createKickPublicKeySource(
  options: { readonly fetch?: typeof fetch; readonly now?: () => number; readonly url?: string } = {},
): KickPublicKeySource {
  const fetchKey = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const url = options.url ?? kickPublicKeyUrl;
  let key: string | null = null;
  let fetchedAt = Number.NEGATIVE_INFINITY;

  async function download(): Promise<string> {
    const response = await fetchKey(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
    if (!response.ok) throw new Error(`Kick public key request failed with HTTP ${response.status}`);
    const pem = responseSchema.parse(await response.json()).data.public_key;
    key = pem;
    fetchedAt = now();
    return pem;
  }

  return {
    async current() {
      return key ?? download();
    },
    async refresh() {
      if (now() - fetchedAt < refreshIntervalMs) return null;
      try {
        return await download();
      } catch {
        // Recorded as an attempt, so an outage is not retried on every request.
        fetchedAt = now();
        return null;
      }
    },
  };
}
