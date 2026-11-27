import type { VoiceFilter, VoiceInfo, VoiceSource } from './catalog';

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

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

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: Fetch = fetch as unknown as Fetch,
    private readonly host = 'https://api.elevenlabs.io',
  ) {}

  private async get(path: string): Promise<unknown> {
    const res = await this.fetchFn(`${this.host}${path}`, { headers: { 'xi-api-key': this.apiKey } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = (body as { detail?: { message?: string } }).detail;
      throw new Error(detail?.message ?? `ElevenLabs HTTP ${res.status}`);
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
    if (this.libraryCache.size > 200) this.libraryCache.clear();
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
    const own = await this.list({});
    const known = own.find((v) => v.id === id) ?? [...this.libraryCache.values()].flatMap((c) => c.voices).find((v) => v.id === id);
    if (known) return known;
    // An id we have not listed: usable only where the library is.
    if ((await this.canUseLibrary()) && /^elevenlabs:[A-Za-z0-9]{10,40}$/.test(id)) {
      return { id, name: id.slice(11), provider: 'elevenlabs', gender: 'neutral', accent: 'Unspecified', age: 'middle-aged', description: 'voice library', previewUrl: '' };
    }
    return undefined;
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
