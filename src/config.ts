/**
 * Configuration, read once from environment variables at startup.
 *
 * Every variable is validated here so a misconfigured deployment fails at boot
 * with a message naming the variable, rather than at the first donation. The
 * documented list of variables lives in `.env.example`; keep the two in sync.
 */
import { z } from 'zod';
import { currencyFractionDigits, parseAmountToMinorUnits } from './money.ts';
import { nowPaymentsBaseUrls } from './nowpayments/nowpayments-client.ts';

/** Thrown when the environment does not describe a valid configuration. */
export class ConfigError extends Error {
  /** One human-readable line per invalid or missing variable. */
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * `docker compose` passes `FOO=` from an env file through as an empty string.
 * Treating that as "unset" lets defaults apply and lets required variables
 * report as missing instead of as invalid.
 */
const emptyAsUnset = (value: unknown) => (value === '' ? undefined : value);

const isKnownCurrency = (code: string) => {
  try {
    currencyFractionDigits(code);
    return true;
  } catch {
    return false;
  }
};

const environmentSchema = z.object({
  HOST: z.preprocess(emptyAsUnset, z.string().default('0.0.0.0')),
  PORT: z.preprocess(emptyAsUnset, z.coerce.number().int().min(1).max(65535).default(3000)),
  LOG_LEVEL: z.preprocess(
    emptyAsUnset,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ),
  // The address viewers and NOWPayments reach this service on. Used to build the
  // webhook URL and checkout redirects, so it must be the public origin, not the
  // container's own address.
  PUBLIC_BASE_URL: z.preprocess(
    emptyAsUnset,
    z
      .url({ protocol: /^https?$/ })
      .transform((url) => url.replace(/\/+$/, '')),
  ),
  // Relative paths resolve against the working directory, which is /app in the
  // Docker image, so the default lands in the mounted /app/data volume.
  DATABASE_PATH: z.preprocess(emptyAsUnset, z.string().default('data/crypto-dono.sqlite')),
  STREAMER_NAME: z.preprocess(emptyAsUnset, z.string().trim().max(60).default('')),

  NOWPAYMENTS_API_KEY: z.preprocess(emptyAsUnset, z.string().trim().min(1)),
  NOWPAYMENTS_SANDBOX: z.preprocess(emptyAsUnset, z.stringbool().default(false)),

  DONATION_CURRENCY: z.preprocess(
    emptyAsUnset,
    z
      .string()
      .trim()
      .toLowerCase()
      .refine(isKnownCurrency, 'must be an ISO 4217 currency code such as usd or eur')
      .default('usd'),
  ),
  // Kept as strings here and converted to minor units below, because the number
  // of decimals depends on DONATION_CURRENCY.
  DONATION_MIN_AMOUNT: z.preprocess(emptyAsUnset, z.string().default('1')),
  DONATION_MAX_AMOUNT: z.preprocess(emptyAsUnset, z.string().default('1000')),
});

export type Config = {
  readonly host: string;
  readonly port: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  /** Public origin without a trailing slash, e.g. `https://dono.example.com`. */
  readonly publicBaseUrl: string;
  readonly databasePath: string;
  /** Shown on the donation page; empty means a generic heading. */
  readonly streamerName: string;
  readonly nowPayments: {
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly sandbox: boolean;
  };
  readonly donation: {
    /** Lower-case ISO 4217 code. */
    readonly currency: string;
    readonly fractionDigits: number;
    readonly minAmountMinor: number;
    readonly maxAmountMinor: number;
  };
};

/**
 * Builds the configuration from an environment map.
 *
 * @param environment Usually `process.env`; injected so tests need no globals.
 * @returns The validated configuration.
 * @throws {ConfigError} Listing every invalid or missing variable at once, so a
 *   self-hoster fixes their `.env` in one pass rather than one error per boot.
 *   The donation amount range is checked in a second pass, because its decimals
 *   depend on DONATION_CURRENCY being valid first.
 */
export function loadConfig(environment: Readonly<Record<string, string | undefined>>): Config {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => describeIssue(issue, environment)));
  }
  const variables = parsed.data;

  const fractionDigits = currencyFractionDigits(variables.DONATION_CURRENCY);
  const amountIssues: string[] = [];
  const minAmountMinor = parseAmountToMinorUnits(variables.DONATION_MIN_AMOUNT, fractionDigits);
  const maxAmountMinor = parseAmountToMinorUnits(variables.DONATION_MAX_AMOUNT, fractionDigits);
  const amountFormat = `a plain amount with at most ${fractionDigits} decimals, such as ${fractionDigits > 0 ? '2.50' : '250'}`;
  if (minAmountMinor === undefined || minAmountMinor === 0) {
    amountIssues.push(`DONATION_MIN_AMOUNT: must be ${amountFormat}, and above zero`);
  }
  if (maxAmountMinor === undefined) {
    amountIssues.push(`DONATION_MAX_AMOUNT: must be ${amountFormat}`);
  }
  if (minAmountMinor !== undefined && maxAmountMinor !== undefined && maxAmountMinor < minAmountMinor) {
    amountIssues.push('DONATION_MAX_AMOUNT: must not be below DONATION_MIN_AMOUNT');
  }
  if (amountIssues.length > 0 || minAmountMinor === undefined || maxAmountMinor === undefined) {
    throw new ConfigError(amountIssues);
  }

  return {
    host: variables.HOST,
    port: variables.PORT,
    logLevel: variables.LOG_LEVEL,
    publicBaseUrl: variables.PUBLIC_BASE_URL,
    databasePath: variables.DATABASE_PATH,
    streamerName: variables.STREAMER_NAME,
    nowPayments: {
      apiKey: variables.NOWPAYMENTS_API_KEY,
      baseUrl: variables.NOWPAYMENTS_SANDBOX ? nowPaymentsBaseUrls.sandbox : nowPaymentsBaseUrls.production,
      sandbox: variables.NOWPAYMENTS_SANDBOX,
    },
    donation: {
      currency: variables.DONATION_CURRENCY,
      fractionDigits,
      minAmountMinor,
      maxAmountMinor,
    },
  };
}

function describeIssue(
  issue: z.core.$ZodIssue,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const variableName = issue.path.join('.');
  // Judged from the raw environment, not the issue: zod does not attach the
  // offending input to issues by default, so it cannot tell "unset" from "invalid".
  const rawValue = environment[variableName];
  if (rawValue === undefined || rawValue === '') {
    return `${variableName} is required but not set`;
  }
  return `${variableName}: ${issue.message}`;
}
