/**
 * Client for a Piper text-to-speech HTTP server (`python -m piper.http_server`).
 * API: https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/API_HTTP.md
 */

/** Piper answered, but not with usable audio. */
export class PiperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiperError';
  }
}

export type PiperClient = {
  /**
   * @returns A WAV file.
   * @throws {PiperError} On a non-2xx response or a body that is not a WAV.
   * @throws {DOMException} `TimeoutError` after the timeout; `TypeError` if unreachable.
   */
  synthesize(text: string): Promise<Buffer>;
};

export type PiperClientOptions = {
  /** e.g. `http://piper:5000`, without a trailing slash. */
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
};

/** A 300-character message is a few hundred kilobytes; anything near this is wrong. */
const maximumAudioBytes = 10 * 1024 * 1024;

export function createPiperClient(options: PiperClientOptions): PiperClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  return {
    async synthesize(text) {
      const response = await fetchImplementation(`${options.baseUrl}/synthesize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new PiperError(`Piper responded with HTTP ${response.status}`);
      const audio = Buffer.from(await response.arrayBuffer());
      // Checked by content rather than header: Piper 1.8 labels its WAV text/html.
      if (audio.length > maximumAudioBytes) throw new PiperError(`Piper returned ${audio.length} bytes`);
      if (!isWav(audio)) throw new PiperError('Piper did not return a WAV file');
      return audio;
    },
  };
}

/** RIFF container with a WAVE form type, per the WAV header layout. */
export function isWav(bytes: Buffer): boolean {
  return (
    bytes.length >= 44 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WAVE'
  );
}
