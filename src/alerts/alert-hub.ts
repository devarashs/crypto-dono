/**
 * In-process fan-out of donation alerts to every connected overlay.
 *
 * In memory because this is a single-process, single-streamer service. An alert
 * published while no overlay is connected is not lost: the donation row keeps
 * `alert_shown_at` empty and the overlay replays it on its next connection.
 */
/**
 * What an overlay receives, already filtered (see alert-presenter.ts). Only
 * display fields; nothing about the payment internals.
 */
export type OverlayAlert = {
  /** The donation's public id, used to acknowledge the alert once shown. */
  readonly id: string;
  readonly donorName: string;
  readonly message: string;
  /** Formatted for display, e.g. "$5.00". */
  readonly amount: string;
  /** Whether the overlay should fetch and play speech for this alert. */
  readonly speak: boolean;
};

export type AlertListener = (alert: OverlayAlert) => void;

export type AlertHub = {
  /** @returns A function that removes the listener. */
  subscribe(listener: AlertListener): () => void;
  /** Delivers to every listener; one failing listener does not stop the others. */
  publish(alert: OverlayAlert): void;
  readonly subscriberCount: number;
};

/**
 * @param onListenerError Called when a listener throws, typically to log it.
 */
export function createAlertHub(onListenerError: (error: unknown) => void = () => {}): AlertHub {
  const listeners = new Set<AlertListener>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(alert) {
      // Copied first so a listener unsubscribing during delivery is safe.
      for (const listener of [...listeners]) {
        try {
          listener(alert);
        } catch (error) {
          onListenerError(error);
        }
      }
    },
    get subscriberCount() {
      return listeners.size;
    },
  };
}
