import { describe, expect, it, vi } from 'vitest';
import { createAlertHub, toOverlayAlert, type OverlayAlert } from '../src/alerts/alert-hub.ts';
import type { Donation } from '../src/donations/donation-repository.ts';

const alert: OverlayAlert = { id: 'a1', donorName: 'Ann', message: 'gg', amount: '$5.00' };

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

describe('toOverlayAlert', () => {
  it('keeps only display fields and formats the amount', () => {
    const donation = {
      publicId: 'p1',
      donorName: 'Ann',
      message: 'gg',
      amountMinor: 123456,
      currency: 'usd',
      nowpaymentsPaymentId: 'secret-ish',
    } as Donation;
    expect(toOverlayAlert(donation)).toEqual({ id: 'p1', donorName: 'Ann', message: 'gg', amount: '$1,234.56' });
  });
});
