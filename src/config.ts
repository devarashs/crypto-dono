/**
 * Configuration, read once from environment variables at startup.
 *
 * Every variable is validated here so a misconfigured deployment fails at boot
 * with a message naming the variable, rather than at the first donation. The
 * documented list of variables lives in `.env.example`; keep the two in sync.
 */
import { statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { z } from 'zod';
import { alertThresholdStatuses, type AlertThresholdStatus } from './donations/payment-status.ts';
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
  // Signs every IPN; without it any caller could fire alerts on stream.
  NOWPAYMENTS_IPN_SECRET: z.preprocess(emptyAsUnset, z.string().trim().min(1)),
  NOWPAYMENTS_SANDBOX: z.preprocess(emptyAsUnset, z.stringbool().default(false)),
  // "confirmed" by default: the blockchain has accepted the payment, so the
  // money is real. "confirming" alerts sooner, as soon as the transaction is
  // seen, at the small risk of alerting for one that never confirms.
  ALERT_ON_STATUS: z.preprocess(emptyAsUnset, z.enum(alertThresholdStatuses).default('confirmed')),
  // The overlay URL is the only thing protecting the alert feed, so it must be
  // long and random, not a memorable word.
  OVERLAY_TOKEN: z.preprocess(
    emptyAsUnset,
    z
      .string()
      .regex(
        /^[A-Za-z0-9_-]{24,}$/,
        'must be at least 24 random letters, digits, "-" or "_". Generate one with: ' +
          `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`,
      ),
  ),

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

  ALERT_DURATION_SECONDS: z.preprocess(emptyAsUnset, z.coerce.number().int().min(2).max(60).default(8)),
  ALERT_TEXT_TEMPLATE: z.preprocess(
    emptyAsUnset,
    z.string().trim().min(1).max(120).default('{name} donated {amount}'),
  ),
  // Folder holding the streamer's own alert sound and image. Relative paths
  // resolve against the working directory (/app in Docker, mounted from ./custom).
  CUSTOM_ASSETS_DIR: z.preprocess(emptyAsUnset, z.string().default('custom')),
  // Empty: the built-in chime. "none": silent. Otherwise a file name in CUSTOM_ASSETS_DIR.
  ALERT_SOUND: z.preprocess(emptyAsUnset, z.string().trim().optional()),
  // Empty: no image. Otherwise a file name in CUSTOM_ASSETS_DIR.
  ALERT_IMAGE: z.preprocess(emptyAsUnset, z.string().trim().optional()),
});

/** Plain file names only: no directories, so a setting can never point outside the folder. */
const assetFileNamePattern = /^[A-Za-z0-9_][A-Za-z0-9_. -]*$/;
const soundExtensions = ['.mp3', '.ogg', '.wav', '.m4a'];
const imageExtensions = ['.gif', '.png', '.webp', '.jpg', '.jpeg', '.avif'];

/** Reports whether a path is an existing regular file. Injected so tests need no real files. */
export type FileExists = (path: string) => boolean;

const fileExistsOnDisk: FileExists = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

export type AlertSound =
  | { readonly kind: 'chime' }
  | { readonly kind: 'none' }
  | { readonly kind: 'file'; readonly fileName: string };

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
    readonly ipnSecret: string;
    readonly baseUrl: string;
    readonly sandbox: boolean;
  };
  /** Payment status from which a donation shows its alert. */
  readonly alertOnStatus: AlertThresholdStatus;
  /** Secret path segment of the OBS overlay URL. */
  readonly overlayToken: string;
  readonly alert: {
    readonly durationMs: number;
    /** Headline wording; `{name}` and `{amount}` are replaced per donation. */
    readonly textTemplate: string;
    /** Absolute path of the folder custom sounds and images are read from. */
    readonly assetsDirectory: string;
    readonly sound: AlertSound;
    /** File name in `assetsDirectory`, or `null` for no image. */
    readonly imageFileName: string | null;
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
export function loadConfig(
  environment: Readonly<Record<string, string | undefined>>,
  fileExists: FileExists = fileExistsOnDisk,
): Config {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => describeIssue(issue, environment)));
  }
  const variables = parsed.data;

  const fractionDigits = currencyFractionDigits(variables.DONATION_CURRENCY);
  // Second pass: checks that depend on more than one variable or on the disk.
  const secondPassIssues: string[] = [];
  const minAmountMinor = parseAmountToMinorUnits(variables.DONATION_MIN_AMOUNT, fractionDigits);
  const maxAmountMinor = parseAmountToMinorUnits(variables.DONATION_MAX_AMOUNT, fractionDigits);
  const amountFormat = `a plain amount with at most ${fractionDigits} decimals, such as ${fractionDigits > 0 ? '2.50' : '250'}`;
  if (minAmountMinor === undefined || minAmountMinor === 0) {
    secondPassIssues.push(`DONATION_MIN_AMOUNT: must be ${amountFormat}, and above zero`);
  }
  if (maxAmountMinor === undefined) {
    secondPassIssues.push(`DONATION_MAX_AMOUNT: must be ${amountFormat}`);
  }
  if (minAmountMinor !== undefined && maxAmountMinor !== undefined && maxAmountMinor < minAmountMinor) {
    secondPassIssues.push('DONATION_MAX_AMOUNT: must not be below DONATION_MIN_AMOUNT');
  }

  const assetsDirectory = resolve(variables.CUSTOM_ASSETS_DIR);
  const checkAsset = (variableName: string, fileName: string, allowedExtensions: readonly string[]) => {
    if (!assetFileNamePattern.test(fileName)) {
      secondPassIssues.push(`${variableName}: must be a plain file name inside CUSTOM_ASSETS_DIR, without folders`);
    } else if (!allowedExtensions.includes(extname(fileName).toLowerCase())) {
      secondPassIssues.push(`${variableName}: must end in one of ${allowedExtensions.join(', ')}`);
    } else if (!fileExists(resolve(assetsDirectory, fileName))) {
      secondPassIssues.push(`${variableName}: no file named "${fileName}" in ${assetsDirectory}`);
    }
  };
  let sound: AlertSound = { kind: 'chime' };
  if (variables.ALERT_SOUND !== undefined && variables.ALERT_SOUND.toLowerCase() === 'none') {
    sound = { kind: 'none' };
  } else if (variables.ALERT_SOUND !== undefined) {
    checkAsset('ALERT_SOUND', variables.ALERT_SOUND, soundExtensions);
    sound = { kind: 'file', fileName: variables.ALERT_SOUND };
  }
  if (variables.ALERT_IMAGE !== undefined) checkAsset('ALERT_IMAGE', variables.ALERT_IMAGE, imageExtensions);

  if (secondPassIssues.length > 0 || minAmountMinor === undefined || maxAmountMinor === undefined) {
    throw new ConfigError(secondPassIssues);
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
      ipnSecret: variables.NOWPAYMENTS_IPN_SECRET,
      baseUrl: variables.NOWPAYMENTS_SANDBOX ? nowPaymentsBaseUrls.sandbox : nowPaymentsBaseUrls.production,
      sandbox: variables.NOWPAYMENTS_SANDBOX,
    },
    alertOnStatus: variables.ALERT_ON_STATUS,
    overlayToken: variables.OVERLAY_TOKEN,
    alert: {
      durationMs: variables.ALERT_DURATION_SECONDS * 1000,
      textTemplate: variables.ALERT_TEXT_TEMPLATE,
      assetsDirectory,
      sound,
      imageFileName: variables.ALERT_IMAGE ?? null,
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
