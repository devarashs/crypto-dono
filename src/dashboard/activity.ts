/**
 * The dashboard's activity feed: platform events, donations and soundboard
 * purchases as one list, newest first.
 *
 * Built on the server as headline parts (like overlay alerts), so the page's
 * script only places text and never interprets it. Names and messages are
 * shown as sent: this is the streamer's private view, like the admin history.
 */
import type { HeadlinePart } from '../alerts/headline.ts';
import type { Donation } from '../donations/donation-repository.ts';
import { eventHeadline } from '../events/event-presenter.ts';
import type { StoredEvent } from '../events/event-log.ts';
import type { StreamEventKind } from '../events/stream-event.ts';
import { formatMoneyForDisplay } from '../money.ts';

export type ActivityItem = {
  readonly id: string;
  /** ISO time it happened. */
  readonly at: string;
  /** Where it came from; drives the icon and colour. */
  readonly source: 'twitch' | 'kick' | 'donation' | 'sound';
  readonly headline: readonly HeadlinePart[];
  /** What the viewer wrote with it, if anything. */
  readonly message?: string;
};

export function activityFromEvent(event: StoredEvent, templates: Readonly<Record<StreamEventKind, string>>): ActivityItem {
  return {
    id: event.alertId,
    at: event.receivedAt,
    // Only real platforms are stored; the test page's events never reach here.
    source: event.platform === 'kick' ? 'kick' : 'twitch',
    headline: eventHeadline(event, templates, event.actorName),
    ...(event.message !== undefined && event.message !== '' && { message: event.message }),
  };
}

/** A paid donation or sound; `null` for one whose alert has not fired. */
export function activityFromDonation(donation: Donation): ActivityItem | null {
  if (donation.alertTriggeredAt === null) return null;
  const amount = formatMoneyForDisplay(donation.amountMinor, donation.currency);
  if (donation.sound !== null) {
    return {
      id: donation.publicId,
      at: donation.alertTriggeredAt,
      source: 'sound',
      headline: [
        { text: `${donation.donorName} played `, emphasis: false },
        { text: donation.sound.name, emphasis: true },
        { text: ` (${amount})`, emphasis: false },
      ],
    };
  }
  return {
    id: donation.publicId,
    at: donation.alertTriggeredAt,
    source: 'donation',
    headline: [
      { text: `${donation.donorName} donated `, emphasis: false },
      { text: amount, emphasis: true },
    ],
    ...(donation.message !== '' && { message: donation.message }),
  };
}

/** Merges lists into one, newest first, at most `limit`. */
export function mergeActivity(lists: readonly (readonly ActivityItem[])[], limit: number): ActivityItem[] {
  return lists
    .flat()
    .sort((first, second) => (first.at < second.at ? 1 : first.at > second.at ? -1 : 0))
    .slice(0, limit);
}
