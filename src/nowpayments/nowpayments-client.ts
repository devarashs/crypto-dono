/**
 * Minimal NOWPayments API client: only the calls this service makes.
 *
 * API reference: https://documenter.getpostman.com/view/7907941/2s93JusNJt
 */
import { z } from 'zod';

export const nowPaymentsBaseUrls = {
  production: 'https://api.nowpayments.io/v1',
  sandbox: 'https://api-sandbox.nowpayments.io/v1',
} as const;

/** NOWPayments answered, but not with success. */
export class NowPaymentsApiError extends Error {
  readonly statusCode: number;
  /** Truncated response body, for logs. Never shown to donors. */
  readonly responseBody: string;

  constructor(statusCode: number, responseBody: string) {
    super(`NOWPayments responded with HTTP ${statusCode}`);
    this.name = 'NowPaymentsApiError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export type CreateInvoiceRequest = {
  /** Decimal string in `priceCurrency`, e.g. "5.00". */
  readonly priceAmount: string;
  /** Lower-case fiat code, e.g. "usd". */
  readonly priceCurrency: string;
  readonly orderId: string;
  readonly orderDescription: string;
  readonly ipnCallbackUrl: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
};

export type Invoice = {
  readonly invoiceId: string;
  /** NOWPayments' hosted checkout page for this invoice. */
  readonly invoiceUrl: string;
};

// The API returns ids as strings in examples but numbers elsewhere; accept both.
const invoiceResponseSchema = z.object({
  id: z.union([z.string().min(1), z.number().int()]).transform(String),
  invoice_url: z.url({ protocol: /^https$/ }),
});

export type NowPaymentsClient = {
  createInvoice(request: CreateInvoiceRequest): Promise<Invoice>;
};

export type NowPaymentsClientOptions = {
  readonly apiKey: string;
  readonly baseUrl: string;
  /** Per-request timeout. A donor is waiting on the redirect. */
  readonly timeoutMs?: number;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
};

export function createNowPaymentsClient(options: NowPaymentsClientOptions): NowPaymentsClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    /**
     * Creates a hosted-checkout invoice. The donor picks the coin on the
     * checkout page, so no `pay_currency` is sent.
     *
     * @throws {NowPaymentsApiError} On a non-2xx response.
     * @throws {z.ZodError} If a 2xx response lacks an id or an https invoice URL.
     * @throws {DOMException} `TimeoutError` after `timeoutMs`, or a network
     *   `TypeError` if NOWPayments is unreachable.
     */
    async createInvoice(request) {
      const response = await fetchImplementation(`${options.baseUrl}/invoice`, {
        method: 'POST',
        headers: { 'x-api-key': options.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          // Sent as a JSON number, which the API requires. The string came from
          // integer minor units, so it is exact to the currency's precision.
          price_amount: Number(request.priceAmount),
          price_currency: request.priceCurrency,
          order_id: request.orderId,
          order_description: request.orderDescription,
          ipn_callback_url: request.ipnCallbackUrl,
          success_url: request.successUrl,
          cancel_url: request.cancelUrl,
          // Fixed rate would expire unpaid invoices after 10 minutes, which is
          // hostile to a viewer fumbling with a wallet mid-stream.
          is_fixed_rate: false,
          // The streamer absorbs network fees, so the donor pays what they typed.
          is_fee_paid_by_user: false,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const responseText = await response.text();
      if (!response.ok) {
        throw new NowPaymentsApiError(response.status, responseText.slice(0, 500));
      }
      const parsed = invoiceResponseSchema.parse(JSON.parse(responseText));
      return { invoiceId: parsed.id, invoiceUrl: parsed.invoice_url };
    },
  };
}
