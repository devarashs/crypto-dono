/**
 * In-process fan-out to open dashboard pages: activity (events, donations,
 * sounds), and later chat and stream status. Like the alert hub, in memory:
 * one process, one streamer.
 */
import type { ActivityItem } from './activity.ts';
import type { ChannelStatus } from './stream-status.ts';

export type DashboardMessage =
  | { readonly type: 'activity'; readonly item: ActivityItem }
  | { readonly type: 'status'; readonly statuses: readonly ChannelStatus[] };

export type DashboardListener = (message: DashboardMessage) => void;

export type DashboardHub = ReturnType<typeof createDashboardHub>;

/** @param onListenerError Called when a listener throws, typically to log it. */
export function createDashboardHub(onListenerError: (error: unknown) => void = () => {}) {
  const listeners = new Set<DashboardListener>();
  return {
    /** @returns A function that removes the listener. */
    subscribe(listener: DashboardListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Delivers to every listener; one failing listener does not stop the others. */
    publish(message: DashboardMessage): void {
      for (const listener of [...listeners]) {
        try {
          listener(message);
        } catch (error) {
          onListenerError(error);
        }
      }
    },
    get subscriberCount(): number {
      return listeners.size;
    },
  };
}
