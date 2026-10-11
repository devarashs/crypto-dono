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
  /**
   * Set when the streamer replays the alert on purpose. Overlays normally drop
   * an alert id they have already seen (a reconnect resends pending alerts); a
   * deliberate replay must get through anyway.
   */
  readonly replay?: true;
};

export type AlertListener = (alert: OverlayAlert) => void;

/** Receives the id of an alert the streamer skipped. */
export type SkipListener = (alertId: string) => void;

export type AlertHub = {
  /** @returns A function that removes the listener. */
  subscribe(listener: AlertListener): () => void;
  /** Delivers to every listener; one failing listener does not stop the others. */
  publish(alert: OverlayAlert): void;
  /** @returns A function that removes the listener. */
  subscribeToSkips(listener: SkipListener): () => void;
  /** Tells overlays to drop an alert, whether it is queued or on screen. */
  skip(alertId: string): void;
  readonly subscriberCount: number;
};

/**
 * @param onListenerError Called when a listener throws, typically to log it.
 */
export function createAlertHub(onListenerError: (error: unknown) => void = () => {}): AlertHub {
  const listeners = new Set<AlertListener>();
  const skipListeners = new Set<SkipListener>();

  function deliver<T>(targets: Set<(value: T) => void>, value: T): void {
    // Copied first so a listener unsubscribing during delivery is safe.
    for (const listener of [...targets]) {
      try {
        listener(value);
      } catch (error) {
        onListenerError(error);
      }
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(alert) {
      deliver(listeners, alert);
    },
    subscribeToSkips(listener) {
      skipListeners.add(listener);
      return () => {
        skipListeners.delete(listener);
      };
    },
    skip(alertId) {
      deliver(skipListeners, alertId);
    },
    get subscriberCount() {
      return listeners.size;
    },
  };
}
