import { describe, expect, it, vi } from 'vitest';
import { createAlertHub, type OverlayAlert } from '../src/alerts/alert-hub.ts';

const alert: OverlayAlert = { id: 'a1', donorName: 'Ann', message: 'gg', amount: '$5.00', speak: false };

describe('createAlertHub', () => {
  it('delivers to every subscriber', () => {
    const hub = createAlertHub();
    const first = vi.fn();
    const second = vi.fn();
    hub.subscribe(first);
    hub.subscribe(second);
    hub.publish(alert);
    expect(first).toHaveBeenCalledWith(alert);
    expect(second).toHaveBeenCalledWith(alert);
  });

  it('stops delivering after unsubscribe', () => {
    const hub = createAlertHub();
    const listener = vi.fn();
    const unsubscribe = hub.subscribe(listener);
    expect(hub.subscriberCount).toBe(1);
    unsubscribe();
    unsubscribe();
    hub.publish(alert);
    expect(listener).not.toHaveBeenCalled();
    expect(hub.subscriberCount).toBe(0);
  });

  it('publishing with no subscribers is a no-op', () => {
    expect(() => createAlertHub().publish(alert)).not.toThrow();
  });

  it('keeps delivering when one listener throws, and reports the error', () => {
    const onListenerError = vi.fn();
    const hub = createAlertHub(onListenerError);
    const healthy = vi.fn();
    hub.subscribe(() => {
      throw new Error('socket closed');
    });
    hub.subscribe(healthy);
    hub.publish(alert);
    expect(healthy).toHaveBeenCalledOnce();
    expect(onListenerError).toHaveBeenCalledWith(expect.objectContaining({ message: 'socket closed' }));
  });

  it('tolerates a listener unsubscribing itself during delivery', () => {
    const hub = createAlertHub();
    const later = vi.fn();
    const unsubscribe = hub.subscribe(() => unsubscribe());
    hub.subscribe(later);
    hub.publish(alert);
    expect(later).toHaveBeenCalledOnce();
    expect(hub.subscriberCount).toBe(1);
  });
});

describe('skips', () => {
  it('delivers skips to skip listeners only, until unsubscribed', () => {
    const hub = createAlertHub();
    const onSkip = vi.fn();
    const onAlert = vi.fn();
    const unsubscribe = hub.subscribeToSkips(onSkip);
    hub.subscribe(onAlert);
    hub.skip('a1');
    expect(onSkip).toHaveBeenCalledWith('a1');
    expect(onAlert).not.toHaveBeenCalled();
    unsubscribe();
    hub.skip('a2');
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it('isolates a failing skip listener', () => {
    const onListenerError = vi.fn();
    const hub = createAlertHub(onListenerError);
    const healthy = vi.fn();
    hub.subscribeToSkips(() => {
      throw new Error('closed');
    });
    hub.subscribeToSkips(healthy);
    hub.skip('a1');
    expect(healthy).toHaveBeenCalledWith('a1');
    expect(onListenerError).toHaveBeenCalledOnce();
  });
});
