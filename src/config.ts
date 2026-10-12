/**
 * Configuration, read once from environment variables at startup.
 *
 * Every variable is validated here so a misconfigured deployment fails at boot
 * with a message naming the variable, rather than at the first donation. The
 * documented list of variables lives in `.env.example`; keep the two in sync.
 */
import { readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { z } from 'zod';
import { alertThresholdStatuses, type AlertThresholdStatus } from './donations/payment-status.ts';
import {
  defaultEventTemplates,
  switchableEventKinds,
  type StreamEventKind,
  type SwitchableEventKind,
} from './events/stream-event.ts';
import { currencyFractionDigits, parseAmountToMinorUnits } from './money.ts';
import { parseSoundboard, type Sound } from './soundboard/soundboard.ts';
import { socialIcons } from './web/social-icons.ts';
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

function eventTemplate(kind: StreamEventKind) {
  return z.preprocess(emptyAsUnset, z.string().trim().min(1).max(120).default(defaultEventTemplates[kind]));
}

function optionalText() {
  return z.preprocess(emptyAsUnset, z.string().trim().optional());
}

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
  // Comma-separated amounts offered as one-tap chips, or "none" for no chips.
  // Unset means the defaults below, trimmed to the configured amount range.
  DONATION_PRESETS: z.preprocess(emptyAsUnset, z.string().optional()),

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

  // Platform event alerts (follows, subs, ...). Which kinds alert at all:
  EVENT_ALERTS: z.preprocess(emptyAsUnset, z.string().default(switchableEventKinds.join(','))),
  EVENT_DURATION_SECONDS: z.preprocess(emptyAsUnset, z.coerce.number().int().min(2).max(60).default(6)),
  // Optional wording per kind; {name}, {months}, {count}, {subs}, {bits},
  // {viewers} are filled in. Defaults in events/stream-event.ts.
  EVENT_TEMPLATE_FOLLOW: eventTemplate('follow'),
  EVENT_TEMPLATE_SUB: eventTemplate('sub'),
  EVENT_TEMPLATE_RESUB: eventTemplate('resub'),
  EVENT_TEMPLATE_GIFT: eventTemplate('gift'),
  EVENT_TEMPLATE_CHEER: eventTemplate('cheer'),
  EVENT_TEMPLATE_KICKS: eventTemplate('kicks'),
  EVENT_TEMPLATE_RAID: eventTemplate('raid'),
  // Optional sound per kind: empty for the kind's built-in tone, "none", or a
  // file in CUSTOM_ASSETS_DIR. Resubs use EVENT_SOUND_SUB.
  EVENT_SOUND_FOLLOW: optionalText(),
  EVENT_SOUND_SUB: optionalText(),
  EVENT_SOUND_GIFT: optionalText(),
  EVENT_SOUND_CHEER: optionalText(),
  EVENT_SOUND_RAID: optionalText(),

  // Address of a Piper text-to-speech server. Unset means alerts are not spoken.
  TTS_URL: z.preprocess(
    emptyAsUnset,
    z
      .url({ protocol: /^https?$/ })
      .transform((url) => url.replace(/\/+$/, ''))
      .optional(),
  ),
  TTS_TEMPLATE: z.preprocess(
    emptyAsUnset,
    z.string().trim().min(1).max(200).default('{name} donated {amount}. {message}'),
  ),

  // Unset disables the admin page entirely. Not trimmed: spaces are part of a password.
  ADMIN_PASSWORD: z.preprocess(emptyAsUnset, z.string().min(12, 'must be at least 12 characters').optional()),

  // Comma-separated platform=url pairs for the socials strip, in display order.
  SOCIAL_LINKS: z.preprocess(emptyAsUnset, z.string().default('')),
  // Twitch app credentials (dev.twitch.tv/console). Both or neither; with
  // neither, Twitch alerts are simply not offered.
  TWITCH_CLIENT_ID: z.preprocess(emptyAsUnset, z.string().trim().regex(/^[a-z0-9]+$/, 'should be the Client ID from dev.twitch.tv/console').optional()),
  TWITCH_CLIENT_SECRET: z.preprocess(emptyAsUnset, z.string().trim().min(1).optional()),
  // The public donor leaderboard on the donation page.
  LEADERBOARD: z.preprocess(emptyAsUnset, z.stringbool().default(true)),

  MESSAGE_MAX_LENGTH: z.preprocess(emptyAsUnset, z.coerce.number().int().min(10).max(500).default(300)),
  // Comma-separated words or phrases to mask in names and messages.
  BANNED_WORDS: z.preprocess(
    emptyAsUnset,
    z
      .string()
      .default('')
      .transform((list) =>
        list
          .split(',')
          .map((word) => word.trim())
          .filter((word) => word !== ''),
      )
      .refine((words) => words.length <= 1000, 'at most 1000 words'),
  ),
  // Amounts in DONATION_CURRENCY, converted with the amount range below.
  MESSAGE_MIN_AMOUNT: z.preprocess(emptyAsUnset, z.string().default('0')),
  TTS_MIN_AMOUNT: z.preprocess(emptyAsUnset, z.string().default('0')),
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

/** Reads a text file, or returns `undefined` when there is none. Injected like FileExists. */
export type ReadTextFile = (path: string) => string | undefined;

const readTextFileFromDisk: ReadTextFile = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

/** The soundboard is on exactly when this file exists in CUSTOM_ASSETS_DIR. */
export const soundboardFileName = 'soundboard.json';

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
  /** Links in the socials strip, in display order; empty for no strip. */
  readonly socialLinks: readonly SocialLink[];
  /** Twitch app credentials, or `null` when Twitch is not configured. */
  readonly twitch: { readonly clientId: string; readonly clientSecret: string } | null;
  /** Whether the donation page shows the public leaderboard. */
  readonly leaderboardEnabled: boolean;
  /** Admin page password, or `null` when the admin page is disabled. */
  readonly adminPassword: string | null;
  readonly filters: {
    readonly messageMaxLength: number;
    readonly bannedWords: readonly string[];
    /** Below this, alerts show without the donor's message. */
    readonly messageMinAmountMinor: number;
    /** Below this, alerts are not read aloud. */
    readonly speechMinAmountMinor: number;
  };
  readonly events: {
    /** Kinds that alert; a kind not listed is ignored when it arrives. */
    readonly enabled: ReadonlySet<SwitchableEventKind>;
    readonly durationMs: number;
    readonly templates: Readonly<Record<StreamEventKind, string>>;
    /** "chime" here means the kind's own built-in tone. */
    readonly sounds: Readonly<Record<SwitchableEventKind, AlertSound>>;
  };
  /** Sounds viewers can pay to play, or `null` when there is no valid soundboard file. */
  readonly soundboard: readonly Sound[] | null;
  /** Why soundboard.json was not used; empty when it was fine or absent. */
  readonly soundboardIssues: readonly string[];
  /** Text-to-speech, or `null` when TTS_URL is not set. */
  readonly tts: {
    /** Piper server origin without a trailing slash. */
    readonly url: string;
    /** What is spoken; `{name}`, `{amount}` and `{message}` are replaced. */
    readonly template: string;
  } | null;
  readonly donation: {
    /** Lower-case ISO 4217 code. */
    readonly currency: string;
    readonly fractionDigits: number;
    readonly minAmountMinor: number;
    readonly maxAmountMinor: number;
    /** One-tap amounts, ascending and distinct; empty for no chips. */
    readonly presetsMinor: readonly number[];
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
  readTextFile: ReadTextFile = readTextFileFromDisk,
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
  const presetsGiven = variables.DONATION_PRESETS !== undefined;
  let presetsMinor = parsePresets(
    variables.DONATION_PRESETS ?? defaultPresets,
    fractionDigits,
    amountFormat,
    secondPassIssues,
  );
  if (minAmountMinor !== undefined && maxAmountMinor !== undefined) {
    const inRange = (preset: number) => preset >= minAmountMinor && preset <= maxAmountMinor;
    if (!presetsGiven) {
      // Defaults the streamer never chose must not block startup: keep the ones
      // that fit their range and drop the rest.
      presetsMinor = presetsMinor.filter(inRange);
    } else if (!presetsMinor.every(inRange)) {
      secondPassIssues.push('DONATION_PRESETS: every amount must lie between DONATION_MIN_AMOUNT and DONATION_MAX_AMOUNT');
    }
  }
  const socialLinks = parseSocialLinks(variables.SOCIAL_LINKS, secondPassIssues);
  if ((variables.TWITCH_CLIENT_ID === undefined) !== (variables.TWITCH_CLIENT_SECRET === undefined)) {
    secondPassIssues.push('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET: set both, or neither');
  }
  const messageMinAmountMinor = parseAmountToMinorUnits(variables.MESSAGE_MIN_AMOUNT, fractionDigits);
  const speechMinAmountMinor = parseAmountToMinorUnits(variables.TTS_MIN_AMOUNT, fractionDigits);
  if (messageMinAmountMinor === undefined) secondPassIssues.push(`MESSAGE_MIN_AMOUNT: must be ${amountFormat}`);
  if (speechMinAmountMinor === undefined) secondPassIssues.push(`TTS_MIN_AMOUNT: must be ${amountFormat}`);
  if (minAmountMinor !== undefined && maxAmountMinor !== undefined && maxAmountMinor < minAmountMinor) {
    secondPassIssues.push('DONATION_MAX_AMOUNT: must not be below DONATION_MIN_AMOUNT');
  }

  const assetsDirectory = resolve(variables.CUSTOM_ASSETS_DIR);
  const checkAsset = (
    variableName: string,
    fileName: string,
    allowedExtensions: readonly string[],
    issues: string[] = secondPassIssues,
  ) => {
    if (!assetFileNamePattern.test(fileName)) {
      issues.push(`${variableName}: must be a plain file name inside CUSTOM_ASSETS_DIR, without folders`);
    } else if (!allowedExtensions.includes(extname(fileName).toLowerCase())) {
      issues.push(`${variableName}: must end in one of ${allowedExtensions.join(', ')}`);
    } else if (!fileExists(resolve(assetsDirectory, fileName))) {
      issues.push(`${variableName}: no file named "${fileName}" in ${assetsDirectory}`);
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

  const readSound = (variableName: string, value: string | undefined): AlertSound => {
    if (value === undefined) return { kind: 'chime' };
    if (value.toLowerCase() === 'none') return { kind: 'none' };
    checkAsset(variableName, value, soundExtensions);
    return { kind: 'file', fileName: value };
  };
  const eventSounds: Record<SwitchableEventKind, AlertSound> = {
    follow: readSound('EVENT_SOUND_FOLLOW', variables.EVENT_SOUND_FOLLOW),
    sub: readSound('EVENT_SOUND_SUB', variables.EVENT_SOUND_SUB),
    gift: readSound('EVENT_SOUND_GIFT', variables.EVENT_SOUND_GIFT),
    cheer: readSound('EVENT_SOUND_CHEER', variables.EVENT_SOUND_CHEER),
    raid: readSound('EVENT_SOUND_RAID', variables.EVENT_SOUND_RAID),
  };
  const eventTemplates: Record<StreamEventKind, string> = {
    follow: variables.EVENT_TEMPLATE_FOLLOW,
    sub: variables.EVENT_TEMPLATE_SUB,
    resub: variables.EVENT_TEMPLATE_RESUB,
    gift: variables.EVENT_TEMPLATE_GIFT,
    cheer: variables.EVENT_TEMPLATE_CHEER,
    kicks: variables.EVENT_TEMPLATE_KICKS,
    raid: variables.EVENT_TEMPLATE_RAID,
  };
  // A soundboard problem turns the soundboard off rather than stopping the
  // service: the list is edited often, and a typo in it must not take the
  // donation page down. The problems are logged at startup instead.
  let soundboard: readonly Sound[] | null = null;
  const soundboardIssues: string[] = [];
  const soundboardText = readTextFile(resolve(assetsDirectory, soundboardFileName));
  if (soundboardText !== undefined && minAmountMinor !== undefined && maxAmountMinor !== undefined) {
    const parsedSoundboard = parseSoundboard(soundboardText, { fractionDigits, minAmountMinor, maxAmountMinor });
    soundboardIssues.push(...parsedSoundboard.issues);
    for (const sound of parsedSoundboard.sounds) {
      checkAsset(`sound "${sound.id}" file`, sound.fileName, soundExtensions, soundboardIssues);
    }
    if (soundboardIssues.length === 0) soundboard = parsedSoundboard.sounds;
  }

  const enabledEvents = new Set<SwitchableEventKind>();
  const eventList = variables.EVENT_ALERTS.trim().toLowerCase();
  if (eventList !== 'none') {
    for (const entry of eventList.split(',').map((item) => item.trim()).filter((item) => item !== '')) {
      if ((switchableEventKinds as readonly string[]).includes(entry)) enabledEvents.add(entry as SwitchableEventKind);
      else secondPassIssues.push(`EVENT_ALERTS: unknown kind "${entry}". Use ${switchableEventKinds.join(', ')}, or none`);
    }
  }

  if (
    secondPassIssues.length > 0 ||
    minAmountMinor === undefined ||
    maxAmountMinor === undefined ||
    messageMinAmountMinor === undefined ||
    speechMinAmountMinor === undefined
  ) {
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
    socialLinks,
    twitch:
      variables.TWITCH_CLIENT_ID !== undefined && variables.TWITCH_CLIENT_SECRET !== undefined
        ? { clientId: variables.TWITCH_CLIENT_ID, clientSecret: variables.TWITCH_CLIENT_SECRET }
        : null,
    leaderboardEnabled: variables.LEADERBOARD,
    adminPassword: variables.ADMIN_PASSWORD ?? null,
    filters: {
      messageMaxLength: variables.MESSAGE_MAX_LENGTH,
      bannedWords: variables.BANNED_WORDS,
      messageMinAmountMinor,
      speechMinAmountMinor,
    },
    events: {
      enabled: enabledEvents,
      durationMs: variables.EVENT_DURATION_SECONDS * 1000,
      templates: eventTemplates,
      sounds: eventSounds,
    },
    soundboard,
    soundboardIssues,
    tts: variables.TTS_URL === undefined ? null : { url: variables.TTS_URL, template: variables.TTS_TEMPLATE },
    donation: {
      currency: variables.DONATION_CURRENCY,
      fractionDigits,
      minAmountMinor,
      maxAmountMinor,
      presetsMinor,
    },
  };
}

export type SocialLink = {
  /** A key of socialIcons (e.g. "twitch"), or "link" for any other site. */
  readonly platform: string;
  /** Absolute https URL. */
  readonly url: string;
};

/** Enough for every platform a streamer uses; more turns a quiet strip into clutter. */
const maximumSocialLinks = 10;

/**
 * Parses SOCIAL_LINKS ("twitch=https://twitch.tv/me,kick=https://kick.com/me").
 * Only https URLs are accepted: these become links on a public page, and a
 * javascript: or plain-http URL must never get there by a typo.
 */
function parseSocialLinks(list: string, issues: string[]): SocialLink[] {
  const entries = list
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length > maximumSocialLinks) {
    issues.push(`SOCIAL_LINKS: at most ${maximumSocialLinks} links`);
    return [];
  }
  const links: SocialLink[] = [];
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    const platform = entry.slice(0, Math.max(separator, 0)).trim().toLowerCase();
    const url = entry.slice(separator + 1).trim();
    if (separator <= 0 || url === '') {
      issues.push(`SOCIAL_LINKS: "${entry}" should look like platform=https://...`);
      continue;
    }
    if (platform !== 'link' && !(platform in socialIcons)) {
      issues.push(
        `SOCIAL_LINKS: unknown platform "${platform}". Use one of ${Object.keys(socialIcons).join(', ')}, or "link" for any other site`,
      );
      continue;
    }
    if (!isHttpsUrl(url)) {
      issues.push(`SOCIAL_LINKS: the ${platform} link must be a full https:// address`);
      continue;
    }
    links.push({ platform, url });
  }
  return links;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Chips offered when DONATION_PRESETS is unset, in the donation currency. */
const defaultPresets = '5,10,25,50,100';

/** Upper bound on chips: beyond this they stop being a quick choice. */
const maximumPresetCount = 8;

/**
 * Parses DONATION_PRESETS into ascending, distinct minor-unit amounts.
 * Problems are appended to `issues` rather than thrown, so they are reported
 * together with every other configuration problem.
 */
function parsePresets(list: string, fractionDigits: number, amountFormat: string, issues: string[]): number[] {
  if (list.trim().toLowerCase() === 'none') return [];
  const entries = list
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const amounts: number[] = [];
  for (const entry of entries) {
    const amount = parseAmountToMinorUnits(entry, fractionDigits);
    if (amount === undefined || amount === 0) {
      issues.push(`DONATION_PRESETS: "${entry}" is not ${amountFormat}, above zero`);
      return [];
    }
    amounts.push(amount);
  }
  const distinct = [...new Set(amounts)].sort((a, b) => a - b);
  if (distinct.length > maximumPresetCount) {
    issues.push(`DONATION_PRESETS: at most ${maximumPresetCount} amounts`);
    return [];
  }
  return distinct;
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
