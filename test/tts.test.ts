import { describe, expect, it, vi } from 'vitest';
import { buildSpeechText, createAlertSpeech } from '../src/tts/alert-speech.ts';
import { createPiperClient, isWav, PiperError } from '../src/tts/piper-client.ts';

function fakeWav(extraBytes = 0): Buffer {
  const header = Buffer.alloc(44 + extraBytes);
  header.write('RIFF', 0, 'ascii');
  header.write('WAVE', 8, 'ascii');
  return header;
}

describe('isWav', () => {
  it('accepts a RIFF/WAVE header', () => {
    expect(isWav(fakeWav())).toBe(true);
  });

  it.each([
    ['too short', Buffer.from('RIFF....WAVE')],
    ['HTML', Buffer.from('<html>'.padEnd(64, ' '))],
    ['RIFF but not WAVE', Buffer.concat([Buffer.from('RIFF0000AVI '), Buffer.alloc(40)])],
  ])('rejects %s', (_label, bytes) => {
    expect(isWav(bytes)).toBe(false);
  });
});

describe('createPiperClient', () => {
  it('posts the text and returns the WAV, ignoring the wrong content type Piper sends', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(new Uint8Array(fakeWav(10)), { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const client = createPiperClient({ baseUrl: 'http://piper:5000', fetch: fetchMock });

    const audio = await client.synthesize('Ann donated $5.00.');

    expect(audio.length).toBe(54);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://piper:5000/synthesize');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'Ann donated $5.00.' });
  });

  it('throws PiperError on an error status', async () => {
    const client = createPiperClient({
      baseUrl: 'http://piper:5000',
      fetch: async () => new Response('boom', { status: 500 }),
    });
    await expect(client.synthesize('x')).rejects.toThrow(PiperError);
  });

  it('throws PiperError when the body is not a WAV', async () => {
    const client = createPiperClient({
      baseUrl: 'http://piper:5000',
      fetch: async () => new Response('<html>error page</html>'.padEnd(100, ' '), { status: 200 }),
    });
    await expect(client.synthesize('x')).rejects.toThrow('did not return a WAV');
  });

  it('times out', async () => {
    const client = createPiperClient({
      baseUrl: 'http://piper:5000',
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    });
    await expect(client.synthesize('x')).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('buildSpeechText', () => {
  const alert = { donorName: 'Ann', amount: '$5.00', message: 'love the stream' };

  it('fills the default template', () => {
    expect(buildSpeechText('{name} donated {amount}. {message}', alert)).toBe('Ann donated $5.00. love the stream');
  });

  it('collapses the gap an empty message leaves', () => {
    expect(buildSpeechText('{name} donated {amount}. {message}', { ...alert, message: '' })).toBe(
      'Ann donated $5.00.',
    );
  });

  it('leaves unknown placeholders literal and repeats known ones', () => {
    expect(buildSpeechText('{name}, {name}! {who}', alert)).toBe('Ann, Ann! {who}');
  });
});

describe('createAlertSpeech', () => {
  it('synthesises once per alert, however many overlays ask', async () => {
    const synthesize = vi.fn(async (text: string) => Buffer.from(text));
    const speech = createAlertSpeech({ synthesize });
    speech.prepare('a1', 'hello');
    speech.prepare('a1', 'hello again');

    const [first, second] = await Promise.all([speech.getAudio('a1'), speech.getAudio('a1')]);

    expect(synthesize).toHaveBeenCalledOnce();
    expect(String(first)).toBe('hello');
    expect(second).toBe(first);
  });

  it('starts synthesis at prepare time, before anyone asks', () => {
    const synthesize = vi.fn(async () => Buffer.alloc(0));
    createAlertSpeech({ synthesize }).prepare('a1', 'hello');
    expect(synthesize).toHaveBeenCalledWith('hello');
  });

  it('returns undefined for an alert that was never prepared', () => {
    expect(createAlertSpeech({ synthesize: async () => Buffer.alloc(0) }).getAudio('nope')).toBeUndefined();
  });

  it('forgets a failed synthesis so the next prepare retries', async () => {
    const onError = vi.fn();
    const synthesize = vi
      .fn<(text: string) => Promise<Buffer>>()
      .mockRejectedValueOnce(new Error('piper down'))
      .mockResolvedValueOnce(Buffer.from('ok'));
    const speech = createAlertSpeech({ synthesize, onError });

    speech.prepare('a1', 'hello');
    await expect(speech.getAudio('a1')).rejects.toThrow('piper down');
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'piper down' }), 'a1');
    expect(speech.getAudio('a1')).toBeUndefined();

    speech.prepare('a1', 'hello');
    expect(String(await speech.getAudio('a1'))).toBe('ok');
  });

  it('expires entries after the time limit', async () => {
    let clock = 0;
    const speech = createAlertSpeech({ synthesize: async () => Buffer.alloc(0), now: () => clock, ttlMs: 1000 });
    speech.prepare('a1', 'x');
    clock = 999;
    expect(speech.getAudio('a1')).toBeDefined();
    clock = 1001;
    expect(speech.getAudio('a1')).toBeUndefined();
  });

  it('drops the oldest entries beyond the size limit', () => {
    const speech = createAlertSpeech({ synthesize: async () => Buffer.alloc(0), maxEntries: 2 });
    speech.prepare('a1', 'x');
    speech.prepare('a2', 'x');
    speech.prepare('a3', 'x');
    expect(speech.getAudio('a1')).toBeUndefined();
    expect(speech.getAudio('a2')).toBeDefined();
    expect(speech.getAudio('a3')).toBeDefined();
  });
});
