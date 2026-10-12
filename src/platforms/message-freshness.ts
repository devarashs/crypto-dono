/**
 * Replay protection shared by the platform webhooks: a message whose signed
 * timestamp is too old is refused even with a valid signature, so a captured
 * message cannot be replayed later. Platforms send within seconds and retry
 * within minutes.
 */
export const maximumMessageAgeMs = 10 * 60 * 1000;

/** True if the message timestamp is recent (and not implausibly in the future). */
export function isFreshMessage(timestamp: string, now: number): boolean {
  const sentAt = Date.parse(timestamp);
  if (Number.isNaN(sentAt)) return false;
  return now - sentAt <= maximumMessageAgeMs && sentAt - now <= 60_000;
}
