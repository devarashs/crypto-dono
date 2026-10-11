/**
 * Speech for alerts: the words to say, and a short-lived cache of the audio.
 *
 * Synthesis starts when an alert is published, so the audio is usually ready by
 * the time the overlay asks for it. Every overlay showing the alert (OBS preview
 * and program, a reconnect) shares the one synthesis.
 */
import type { OverlayAlert } from '../alerts/alert-hub.ts';

/**
 * Fills `{name}`, `{amount}` and `{message}` in the speech template. Unknown
 * placeholders stay literal. The result is collapsed to single spaces, so an
 * empty message does not leave a dangling gap.
 */
export function buildSpeechText(template: string, alert: Pick<OverlayAlert, 'donorName' | 'amount' | 'message'>): string {
  const values: Record<string, string> = { name: alert.donorName, amount: alert.amount, message: alert.message };
  return template
    .replace(/\{(name|amount|message)\}/g, (_match, key: string) => values[key] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export type AlertSpeech = {
  /** Records what to say for an alert and starts synthesising it. */
  prepare(alertId: string, text: string): void;
  /**
   * @returns The audio, or `undefined` if the alert was never prepared (or has
   *   expired from the cache). A failed synthesis rejects once and is forgotten,
   *   so a later request retries.
   */
  getAudio(alertId: string): Promise<Buffer> | undefined;
};

export type AlertSpeechOptions = {
  readonly synthesize: (text: string) => Promise<Buffer>;
  readonly now?: () => number;
  /** How long audio is kept; long enough for a queue of alerts to play out. */
  readonly ttlMs?: number;
  /** Bounds memory if alerts arrive in a burst. Oldest entries go first. */
  readonly maxEntries?: number;
  /** Called when synthesis fails, typically to log it. */
  readonly onError?: (error: unknown, alertId: string) => void;
};

type Entry = { readonly createdAt: number; readonly audio: Promise<Buffer> };

export function createAlertSpeech(options: AlertSpeechOptions): AlertSpeech {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 30 * 60 * 1000;
  const maxEntries = options.maxEntries ?? 200;
  // Map keeps insertion order, which is also age order.
  const entries = new Map<string, Entry>();

  function evict(): void {
    const cutoff = now() - ttlMs;
    for (const [id, entry] of entries) {
      if (entry.createdAt >= cutoff && entries.size <= maxEntries) break;
      entries.delete(id);
    }
  }

  return {
    prepare(alertId, text) {
      if (entries.has(alertId)) return;
      const audio = options.synthesize(text);
      audio.catch((error: unknown) => {
        // Forget the failure so the next request tries again.
        if (entries.get(alertId)?.audio === audio) entries.delete(alertId);
        options.onError?.(error, alertId);
      });
      entries.set(alertId, { createdAt: now(), audio });
      evict();
    },
    getAudio(alertId) {
      evict();
      return entries.get(alertId)?.audio;
    },
  };
}
