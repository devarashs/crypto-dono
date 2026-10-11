import { describe, expect, it, vi } from 'vitest';
import {
  createNowPaymentsClient,
  NowPaymentsApiError,
  type CreateInvoiceRequest,
} from '../src/nowpayments/nowpayments-client.ts';

const invoiceRequest: CreateInvoiceRequest = {
  priceAmount: '5.50',
  priceCurrency: 'usd',
  orderId: 'order-1',
  orderDescription: 'Donation to Arash',
  ipnCallbackUrl: 'https://dono.example.com/webhooks/nowpayments',
  successUrl: 'https://dono.example.com/thanks?donation=order-1',
  cancelUrl: 'https://dono.example.com/?cancelled=1',
};

function fakeFetch(status: number, body: string) {
  return vi.fn<typeof fetch>(async () => new Response(body, { status }));
}

describe('createInvoice', () => {
  it('posts the invoice with the API key and returns id and URL', async () => {
    const fetchMock = fakeFetch(
      200,
      JSON.stringify({ id: '4522625843', invoice_url: 'https://nowpayments.io/payment/?iid=4522625843' }),
    );
    const client = createNowPaymentsClient({ apiKey: 'key-1', baseUrl: 'https://api.test/v1', fetch: fetchMock });

    const invoice = await client.createInvoice(invoiceRequest);

    expect(invoice).toEqual({
      invoiceId: '4522625843',
      invoiceUrl: 'https://nowpayments.io/payment/?iid=4522625843',
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.test/v1/invoice');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'x-api-key': 'key-1', 'content-type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toEqual({
      price_amount: 5.5,
      price_currency: 'usd',
      order_id: 'order-1',
      order_description: 'Donation to Arash',
      ipn_callback_url: 'https://dono.example.com/webhooks/nowpayments',
      success_url: 'https://dono.example.com/thanks?donation=order-1',
      cancel_url: 'https://dono.example.com/?cancelled=1',
      is_fixed_rate: false,
      is_fee_paid_by_user: false,
    });
  });

  it('accepts a numeric invoice id', async () => {
    const client = createNowPaymentsClient({
      apiKey: 'k',
      baseUrl: 'https://api.test/v1',
      fetch: fakeFetch(201, JSON.stringify({ id: 42, invoice_url: 'https://nowpayments.io/payment/?iid=42' })),
    });
    expect((await client.createInvoice(invoiceRequest)).invoiceId).toBe('42');
  });

  it('throws NowPaymentsApiError with status and truncated body on failure', async () => {
    const client = createNowPaymentsClient({
      apiKey: 'k',
      baseUrl: 'https://api.test/v1',
      fetch: fakeFetch(403, 'x'.repeat(2000)),
    });
    const error = await client.createInvoice(invoiceRequest).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NowPaymentsApiError);
    expect((error as NowPaymentsApiError).statusCode).toBe(403);
    expect((error as NowPaymentsApiError).responseBody).toHaveLength(500);
  });

  it.each([
    ['no invoice_url', { id: '1' }],
    ['a non-https invoice_url', { id: '1', invoice_url: 'http://evil.test/pay' }],
    ['an empty id', { id: '', invoice_url: 'https://nowpayments.io/payment/?iid=1' }],
  ])('rejects a success response with %s', async (_label, body) => {
    const client = createNowPaymentsClient({
      apiKey: 'k',
      baseUrl: 'https://api.test/v1',
      fetch: fakeFetch(200, JSON.stringify(body)),
    });
    await expect(client.createInvoice(invoiceRequest)).rejects.toThrow();
  });

  it('rejects a success response that is not JSON', async () => {
    const client = createNowPaymentsClient({
      apiKey: 'k',
      baseUrl: 'https://api.test/v1',
      fetch: fakeFetch(200, '<html>maintenance</html>'),
    });
    await expect(client.createInvoice(invoiceRequest)).rejects.toThrow(SyntaxError);
  });

  it('aborts after the timeout', async () => {
    const hangingFetch = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const client = createNowPaymentsClient({
      apiKey: 'k',
      baseUrl: 'https://api.test/v1',
      fetch: hangingFetch,
      timeoutMs: 20,
    });
    await expect(client.createInvoice(invoiceRequest)).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
