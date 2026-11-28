import type { VoiceFilter, VoiceInfo, VoiceSource } from './catalog';

type Fetch = (url: string, init?: { headers?: Record<string, string>; method?: string; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface AccountVoice {
  voice_id: string;
  name: string;
  category?: string;
  description?: string | null;
  preview_url?: string | null;
  labels?: Record<string, string> | null;
}

interface LibraryVoice {
  voice_id: string;
  public_owner_id?: string;
  name: string;
  accent?: string;
  gender?: string;
  age?: string;
  descriptive?: string;
  use_case?: string;
  description?: string | null;
  preview_url?: string | null;
  live_moderation_enabled?: boolean;
  rate?: number;
}

const ACCOUNT_TTL_MS = 10 * 60_000;
const LIBRARY_TTL_MS = 10 * 60_000;
const LIBRARY_PAGE = 30;
/** English accents the ElevenLabs library is labelled with (each has dozens to thousands of voices). */
const LIBRARY_ACCENTS = ['American', 'Australian', 'British', 'Canadian', 'Indian', 'Irish', 'New Zealand', 'Nigerian', 'Scottish', 'South African'];

const title = (s: string): string => s.replace(/(^|[\s-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());

function gender(value: string | undefined): VoiceInfo['gender'] {
  const v = (value ?? '').toLowerCase();
  return v === 'female' || v === 'male' ? v : 'neutral';
}

function age(value: string | undefined): VoiceInfo['age'] {
  const v = (value ?? '').toLowerCase();
  return v === 'young' ? 'young' : v === 'old' ? 'older' : 'middle-aged';
}

/** "Sarah - Mature, Reassuring, Confident" -> name "Sarah", description "mature, reassuring, confident". */
function splitName(raw: string, extra: (string | undefined)[]): { name: string; description: string } {
  const [name, ...rest] = raw.split(/\s+[-–]\s+/);
  const words = [rest.join(', '), ...extra]
    .filter((s): s is string => Boolean(s && s.trim()))
    .map((s) => s.replace(/_/g, ' ').trim().toLowerCase());
  return { name: (name ?? raw).trim(), description: [...new Set(words.join(', ').split(/\s*,\s*/))].join(', ') };
}

/**
 * ElevenLabs voices for the catalog: the account's own voices, and (on a paid
 * plan) the public voice library, searched live with the caller's filters.
 * Ids are "elevenlabs:<voice_id>".
 */
export class ElevenLabsVoices implements VoiceSource {
  readonly provider = 'elevenlabs';
  private account: { at: number; voices: VoiceInfo[]; fromLibrary: Set<string> } | null = null;
  private libraryAllowed: boolean | null = null;
  private planCheckedAt = 0;
  private readonly libraryCache = new Map<string, { at: number; voices: VoiceInfo[] }>();
  private lastError: string | null = null;
  private readonly libraryDetails = new Map<string, LibraryVoice>();
  private readonly preparing = new Map<string, Promise<VoiceInfo>>();

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: Fetch = fetch as unknown as Fetch,
    private readonly host = 'https://api.elevenlabs.io',
  ) {}

  private async get(path: string, payload?: unknown): Promise<unknown> {
    const res = await this.fetchFn(`${this.host}${path}`, {
      headers: { 'xi-api-key': this.apiKey, ...(payload ? { 'content-type': 'application/json' } : {}) },
      ...(payload ? { method: 'POST', body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = (body as { detail?: { message?: string; status?: string } }).detail;
      throw new Error(`ElevenLabs ${detail?.status ?? `HTTP ${res.status}`}: ${detail?.message ?? 'request failed'}`.replaceAll(this.apiKey, '[redacted]').slice(0, 500));
    }
    return body;
  }

  private async accountVoices(): Promise<VoiceInfo[]> {
    if (this.account && Date.now() - this.account.at < ACCOUNT_TTL_MS) return this.account.voices;
    const voices: VoiceInfo[] = [];
    const fromLibrary = new Set<string>();
    let token: string | undefined;
    for (let page = 0; page < 10; page++) {
      const body = (await this.get(`/v2/voices?page_size=100${token ? `&next_page_token=${encodeURIComponent(token)}` : ''}`)) as {
        voices?: AccountVoice[];
        has_more?: boolean;
        next_page_token?: string;
      };
      for (const v of body.voices ?? []) {
        const labels = v.labels ?? {};
        // A library voice saved to the account is still a library voice (unusable on a free plan).
        if (v.category === 'professional' || v.category === 'famous' || v.category === 'high_quality') fromLibrary.add(`elevenlabs:${v.voice_id}`);
        const { name, description } = splitName(v.name, [labels.descriptive ?? labels.description, labels.use_case]);
        voices.push({
          id: `elevenlabs:${v.voice_id}`,
          name,
          provider: 'elevenlabs',
          gender: gender(labels.gender),
          accent: title(labels.accent ?? 'unspecified'),
          age: age(labels.age),
          description: description || (v.description ?? '').slice(0, 80) || 'no description',
          previewUrl: v.preview_url ?? '',
        });
      }
      if (!body.has_more || !body.next_page_token) break;
      token = body.next_page_token;
    }
    this.account = { at: Date.now(), voices, fromLibrary };
    return voices;
  }

  /** The public library is closed to free accounts over the API. */
  private async canUseLibrary(): Promise<boolean> {
    // Re-checked now and then, so upgrading the plan takes effect without a restart.
    if (this.libraryAllowed !== null && Date.now() - this.planCheckedAt < ACCOUNT_TTL_MS) return this.libraryAllowed;
    this.planCheckedAt = Date.now();
    try {
      const sub = (await this.get('/v1/user/subscription')) as { tier?: string };
      this.libraryAllowed = (sub.tier ?? 'free') !== 'free';
    } catch {
      // Cannot tell (the key may not be allowed to read the plan): do not offer voices that may fail.
      this.libraryAllowed = false;
    }
    return this.libraryAllowed;
  }

  private async libraryVoices(filter: VoiceFilter): Promise<VoiceInfo[]> {
    const params = new URLSearchParams({ language: 'en', page_size: String(LIBRARY_PAGE), sort: 'usage_character_count_1y' });
    if (filter.gender) params.set('gender', filter.gender.toLowerCase());
    if (filter.accent) params.set('accent', filter.accent.toLowerCase());
    if (filter.search) params.set('search', filter.search);
    const key = params.toString();
    const cached = this.libraryCache.get(key);
    if (cached && Date.now() - cached.at < LIBRARY_TTL_MS) return cached.voices;
    const body = (await this.get(`/v1/shared-voices?${key}`)) as { voices?: LibraryVoice[] };
    const voices = (body.voices ?? [])
      // Live-moderated voices answer slower; custom-rate voices cost more per character.
      .filter((v) => !v.live_moderation_enabled && (v.rate ?? 1) <= 1)
      .map((v): VoiceInfo => {
        this.libraryDetails.set(`elevenlabs:${v.voice_id}`, v);
        const { name, description } = splitName(v.name, [v.descriptive, v.use_case]);
        return {
          id: `elevenlabs:${v.voice_id}`,
          name,
          provider: 'elevenlabs',
          gender: gender(v.gender),
          accent: title(v.accent ?? 'unspecified'),
          age: age(v.age),
          description: description || 'no description',
          previewUrl: v.preview_url ?? '',
        };
      });
    if (this.libraryCache.size > 200) {
      this.libraryCache.clear();
      // Keep details for this latest result, which may be selected next.
      const keep = new Set(voices.map((v) => v.id));
      for (const id of this.libraryDetails.keys()) if (!keep.has(id)) this.libraryDetails.delete(id);
    }
    this.libraryCache.set(key, { at: Date.now(), voices });
    return voices;
  }

  async list(filter: VoiceFilter): Promise<VoiceInfo[]> {
    this.lastError = null;
    try {
      const own = await this.accountVoices();
      if (!(await this.canUseLibrary())) return own.filter((v) => !this.account!.fromLibrary.has(v.id));
      const library = await this.libraryVoices(filter);
      const seen = new Set(own.map((v) => v.id));
      return [...own, ...library.filter((v) => !seen.has(v.id))];
    } catch (error) {
      // The catalog must still answer (with the other providers) when ElevenLabs is unreachable.
      this.lastError = (error as Error).message;
      return this.account?.voices ?? [];
    }
  }

  async find(id: string): Promise<VoiceInfo | undefined> {
    if (!/^elevenlabs:[A-Za-z0-9]{10,40}$/.test(id)) return undefined;
    const own = (await this.accountVoices()).find((v) => v.id === id);
    if (own && !this.account!.fromLibrary.has(id)) return own;
    if (!(await this.canUseLibrary())) return undefined;
    const known = own ?? [...this.libraryCache.values()].filter((c) => Date.now() - c.at < LIBRARY_TTL_MS).flatMap((c) => c.voices).find((v) => v.id === id);
    if (known) return known;
    // Resolve the exact ID after a restart, even if it is outside the first
    // page of results. A well-formed ID alone is not proof the voice exists.
    return (await this.libraryVoices({ search: id.slice(11) })).find((v) => v.id === id);
  }

  async prepare(id: string): Promise<VoiceInfo> {
    const pending = this.preparing.get(id);
    if (pending) return pending;
    const work = this.prepareVoice(id);
    this.preparing.set(id, work);
    try {
      return await work;
    } finally {
      this.preparing.delete(id);
    }
  }

  private async prepareVoice(id: string): Promise<VoiceInfo> {
    const voice = await this.find(id);
    if (!voice) throw new Error(`unknown ElevenLabs voice "${id}"`);
    if (this.account?.voices.some((v) => v.id === id)) return voice;
    const shared = this.libraryDetails.get(id);
    if (!shared?.public_owner_id) throw new Error('ElevenLabs library voice has no public owner; choose another voice');
    // Library search/preview access does not grant synthesis access. Add only
    // the selected, standard-rate voice; never change the plan or delete voices.
    const added = (await this.get(`/v1/voices/add/${encodeURIComponent(shared.public_owner_id)}/${encodeURIComponent(shared.voice_id)}`, {
      new_name: shared.name,
      bookmarked: false,
    })) as { voice_id?: string };
    if (!added.voice_id || !/^[A-Za-z0-9]{10,40}$/.test(added.voice_id)) throw new Error('ElevenLabs did not return an added voice ID');
    const prepared = { ...voice, id: `elevenlabs:${added.voice_id}` };
    this.account = null; // the account listing is now stale
    return prepared;
  }

  /** Accents the public library can be searched for (it is far larger than any one listing). */
  accents(): string[] {
    return this.libraryAllowed ? LIBRARY_ACCENTS : [];
  }

  notes(): string[] {
    const out: string[] = [];
    if (this.lastError) out.push(`ElevenLabs voices could not be loaded: ${this.lastError}`);
    if (this.libraryAllowed === false) {
      out.push(
        'Only this ElevenLabs account\'s own voices are listed. The ElevenLabs voice library (thousands more, including Irish, Indian, Scottish, Canadian and South African accents) needs a paid ElevenLabs plan to use over the API.',
      );
    }
    return out;
  }
}
