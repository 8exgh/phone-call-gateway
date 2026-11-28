import { ElevenLabsVoices } from '../../src/voices/elevenLabsVoices';
import { VoiceCatalog } from '../../src/voices/catalog';

type Handler = (url: URL, init?: { method?: string; body?: string }) => { status?: number; body: unknown };

function fakeFetch(handler: Handler, calls: string[] = []) {
  return async (url: string, init?: { method?: string; body?: string }) => {
    calls.push(url);
    const { status = 200, body } = handler(new URL(url), init);
    return { ok: status < 400, status, json: async () => body };
  };
}

const ACCOUNT = {
  voices: [
    { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah - Mature, Reassuring, Confident', category: 'premade', preview_url: 'https://cdn.example/sarah.mp3', labels: { accent: 'american', gender: 'female', age: 'young', descriptive: 'professional', use_case: 'entertainment_tv' } },
    { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George - Warm, Captivating Storyteller', category: 'premade', preview_url: 'https://cdn.example/george.mp3', labels: { accent: 'british', gender: 'male', age: 'middle_aged' } },
    { voice_id: 'SAz9YHcvj6GT2YYXdXww', name: 'River', category: 'premade', labels: { accent: 'american', gender: 'neutral', age: 'old' } },
  ],
  has_more: false,
};
const LIBRARY = {
  voices: [
    { voice_id: 'gMlr3DKF9qHZj4NFpVev', public_owner_id: 'public-owner', name: 'Oceana - Warm, Clear', accent: 'irish', gender: 'female', age: 'young', descriptive: 'professional', use_case: 'conversational', preview_url: 'https://cdn.example/oceana.mp3', rate: 1 },
    { voice_id: 'slowModeratedVoice01', name: 'Slow', accent: 'irish', gender: 'female', age: 'young', live_moderation_enabled: true, rate: 1 },
    { voice_id: 'priceyVoice0000000001', name: 'Pricey', accent: 'irish', gender: 'female', age: 'young', rate: 3 },
  ],
};

function source(tier: string | null, calls: string[] = []) {
  return new ElevenLabsVoices(
    'key',
    fakeFetch((url) => {
      if (url.pathname === '/v2/voices') return { body: ACCOUNT };
      if (url.pathname === '/v1/user/subscription') return tier === null ? { status: 401, body: { detail: { message: 'missing permission user_read' } } } : { body: { tier } };
      if (url.pathname === '/v1/shared-voices') return { body: LIBRARY };
      return { status: 404, body: {} };
    }, calls),
  );
}

describe('ElevenLabsVoices', () => {
  it("describes the account's voices by gender, accent and age", async () => {
    const voices = await source('free').list({});
    expect(voices).toEqual([
      { id: 'elevenlabs:EXAVITQu4vr4xnSDxMaL', name: 'Sarah', provider: 'elevenlabs', gender: 'female', accent: 'American', age: 'young', description: 'mature, reassuring, confident, professional, entertainment tv', previewUrl: 'https://cdn.example/sarah.mp3' },
      { id: 'elevenlabs:JBFqnCBsd6RMkjVDRZzb', name: 'George', provider: 'elevenlabs', gender: 'male', accent: 'British', age: 'middle-aged', description: 'warm, captivating storyteller', previewUrl: 'https://cdn.example/george.mp3' },
      { id: 'elevenlabs:SAz9YHcvj6GT2YYXdXww', name: 'River', provider: 'elevenlabs', gender: 'neutral', accent: 'American', age: 'older', description: 'no description', previewUrl: '' },
    ]);
  });

  it('leaves the public library out on a free plan, and says why', async () => {
    const calls: string[] = [];
    const s = source('free', calls);
    const voices = await s.list({ accent: 'irish' });
    expect(voices.some((v) => v.id.endsWith('gMlr3DKF9qHZj4NFpVev'))).toBe(false);
    expect(calls.some((u) => u.includes('/shared-voices'))).toBe(false);
    expect(s.notes()[0]).toContain('paid ElevenLabs plan');
    expect(await s.find('elevenlabs:gMlr3DKF9qHZj4NFpVev')).toBeUndefined();
  });

  it('does not offer the library when it cannot tell which plan the key is on', async () => {
    const s = source(null);
    expect((await s.list({})).length).toBe(3);
    expect(s.notes().length).toBe(1);
  });

  it('searches the library with the filters on a paid plan, skipping slow and surcharged voices', async () => {
    const calls: string[] = [];
    const s = source('creator', calls);
    const voices = await s.list({ accent: 'Irish', gender: 'female' });
    const library = calls.find((u) => u.includes('/shared-voices'))!;
    expect(library).toContain('accent=irish');
    expect(library).toContain('gender=female');
    expect(voices.map((v) => v.name)).toEqual(['Sarah', 'George', 'River', 'Oceana']);
    expect(s.notes()).toEqual([]);
    // A real library voice can be chosen; a plausible-looking invented ID cannot.
    expect((await s.find('elevenlabs:gMlr3DKF9qHZj4NFpVev'))?.accent).toBe('Irish');
    expect(await s.find('elevenlabs:AbCdEfGhIjKlMnOpQrSt')).toBeUndefined();
  });

  it('adds only a selected library voice, once for concurrent requests, and uses the returned ID', async () => {
    let adds = 0;
    const s = new ElevenLabsVoices('key', fakeFetch((url, init) => {
      if (url.pathname === '/v2/voices') return { body: ACCOUNT };
      if (url.pathname === '/v1/user/subscription') return { body: { tier: 'starter' } };
      if (url.pathname === '/v1/shared-voices') return { body: LIBRARY };
      expect(url.pathname).toBe('/v1/voices/add/public-owner/gMlr3DKF9qHZj4NFpVev');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init!.body!)).toEqual({ new_name: 'Oceana - Warm, Clear', bookmarked: false });
      adds++;
      return { body: { voice_id: 'differentAccountId00' } };
    }));
    await s.list({ accent: 'Irish' });
    await s.find('elevenlabs:gMlr3DKF9qHZj4NFpVev');
    expect(adds).toBe(0);
    const selected = await Promise.all([s.prepare('elevenlabs:gMlr3DKF9qHZj4NFpVev'), s.prepare('elevenlabs:gMlr3DKF9qHZj4NFpVev')]);
    expect(adds).toBe(1);
    expect(selected.every((v) => v.id === 'elevenlabs:differentAccountId00')).toBe(true);
    await s.prepare('elevenlabs:EXAVITQu4vr4xnSDxMaL');
    expect(adds).toBe(1);
  });

  it('finds an exact library ID after a restart and propagates add permission errors', async () => {
    let permitted = false;
    const s = new ElevenLabsVoices('key', fakeFetch((url) => {
      if (url.pathname === '/v2/voices') return { body: ACCOUNT };
      if (url.pathname === '/v1/user/subscription') return { body: { tier: 'starter' } };
      if (url.pathname === '/v1/shared-voices') return { body: url.searchParams.get('search') === 'gMlr3DKF9qHZj4NFpVev' ? LIBRARY : { voices: [] } };
      return permitted ? { body: { voice_id: 'gMlr3DKF9qHZj4NFpVev' } } : { status: 401, body: { detail: { status: 'missing_permissions', message: 'missing voices_write' } } };
    }));
    expect((await s.find('elevenlabs:gMlr3DKF9qHZj4NFpVev'))?.name).toBe('Oceana');
    await expect(s.prepare('elevenlabs:gMlr3DKF9qHZj4NFpVev')).rejects.toThrow('missing voices_write');
    permitted = true;
    await expect(s.prepare('elevenlabs:gMlr3DKF9qHZj4NFpVev')).resolves.toHaveProperty('name', 'Oceana');
  });

  it('notices a plan upgrade without a restart', async () => {
    jest.useFakeTimers();
    try {
      let tier = 'free';
      const s = new ElevenLabsVoices(
        'key',
        fakeFetch((url) => {
          if (url.pathname === '/v2/voices') return { body: ACCOUNT };
          if (url.pathname === '/v1/user/subscription') return { body: { tier } };
          return { body: LIBRARY };
        }),
      );
      expect((await s.list({})).length).toBe(3);
      tier = 'starter';
      jest.advanceTimersByTime(11 * 60_000);
      expect((await s.list({})).map((v) => v.name)).toContain('Oceana');
      expect(s.notes()).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the catalog answering when ElevenLabs is down', async () => {
    const down = new ElevenLabsVoices('key', async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const catalog = new VoiceCatalog([down]);
    const all = await catalog.listAll();
    expect(all.length).toBeGreaterThanOrEqual(10);
    expect(all.every((v) => v.provider === 'openai')).toBe(true);
    expect(catalog.notes()[0]).toContain('could not be loaded');
  });

  it('is filtered together with the built-in voices by the catalog', async () => {
    const catalog = new VoiceCatalog([source('free')]);
    const british = await catalog.listAll({ accent: 'british' });
    expect(british.map((v) => v.id)).toEqual(['ballad', 'elevenlabs:JBFqnCBsd6RMkjVDRZzb']);
    const onlyEleven = await catalog.listAll({ provider: 'elevenlabs', gender: 'female' });
    expect(onlyEleven.map((v) => v.name)).toEqual(['Sarah']);
    expect((await catalog.find('elevenlabs:JBFqnCBsd6RMkjVDRZzb'))?.name).toBe('George');
    expect(await catalog.find('nonsense:123')).toBeUndefined();
  });
});
