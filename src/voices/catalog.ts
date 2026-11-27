/**
 * The voices an agent can speak with, described the way a person choosing one
 * needs: who it sounds like (gender, accent, age, character) and a sample to
 * listen to.
 */
export interface VoiceInfo {
  /** What to pass as `voice` (per call, per persona, or as a client default). */
  id: string;
  name: string;
  provider: 'openai' | 'elevenlabs';
  /** How the voice is heard, not a claim about a person. */
  gender: 'female' | 'male' | 'neutral';
  accent: string;
  age: 'young' | 'middle-aged' | 'older';
  /** A few plain adjectives. */
  description: string;
  /** Where to fetch a spoken sample (a WAV on this gateway, or the provider's own preview). */
  previewUrl: string;
}

export interface VoiceFilter {
  gender?: string;
  accent?: string;
  provider?: string;
  /** Free text matched against name, accent and description. */
  search?: string;
}

/**
 * OpenAI's realtime voices. OpenAI publishes no gender or accent for them, so
 * these labels were made by listening: each voice was rendered over a phone
 * line (rig/bench/voices.ts), described twice by an audio model, and checked
 * against its measured speaking pitch (rig/bench/pitch.ts). Where the three
 * disagreed the voice is listed as neutral.
 */
const OPENAI_VOICES: Omit<VoiceInfo, 'previewUrl' | 'provider'>[] = [
  { id: 'marin', name: 'Marin', gender: 'female', accent: 'American', age: 'young', description: 'friendly, clear, approachable' },
  { id: 'cedar', name: 'Cedar', gender: 'male', accent: 'American', age: 'middle-aged', description: 'composed, friendly, professional' },
  { id: 'coral', name: 'Coral', gender: 'female', accent: 'American', age: 'young', description: 'bright, friendly, helpful' },
  { id: 'sage', name: 'Sage', gender: 'female', accent: 'American', age: 'young', description: 'polite, light, approachable' },
  { id: 'shimmer', name: 'Shimmer', gender: 'female', accent: 'American', age: 'middle-aged', description: 'calm, composed, lower-pitched' },
  { id: 'ash', name: 'Ash', gender: 'male', accent: 'American', age: 'middle-aged', description: 'steady, clear, professional' },
  { id: 'echo', name: 'Echo', gender: 'male', accent: 'American', age: 'middle-aged', description: 'calm, steady, even' },
  { id: 'ballad', name: 'Ballad', gender: 'neutral', accent: 'British', age: 'young', description: 'polite, welcoming, melodic' },
  { id: 'alloy', name: 'Alloy', gender: 'neutral', accent: 'American', age: 'young', description: 'clear, upbeat, polite' },
  { id: 'verse', name: 'Verse', gender: 'neutral', accent: 'American', age: 'middle-aged', description: 'warm, calm, relaxed' },
];

/** A provider of further voices (e.g. ElevenLabs), consulted live. */
export interface VoiceSource {
  readonly provider: string;
  list(filter: VoiceFilter): Promise<VoiceInfo[]>;
  find(id: string): Promise<VoiceInfo | undefined>;
  /** Things the person choosing should know (a provider is unreachable, a plan limits the list). */
  notes(): string[];
  /** Accents this provider can be searched for beyond those in the listing at hand. */
  accents(): string[];
}

function matches(v: VoiceInfo, filter: VoiceFilter): boolean {
  const eq = (value: string, wanted?: string): boolean => !wanted || value.toLowerCase() === wanted.trim().toLowerCase();
  const search = filter.search?.trim().toLowerCase();
  return (
    eq(v.gender, filter.gender) &&
    eq(v.provider, filter.provider) &&
    (!filter.accent || v.accent.toLowerCase().includes(filter.accent.trim().toLowerCase())) &&
    (!search || `${v.id} ${v.name} ${v.accent} ${v.gender} ${v.description}`.toLowerCase().includes(search))
  );
}

export class VoiceCatalog {
  private readonly builtIn: VoiceInfo[];

  constructor(private readonly sources: VoiceSource[] = []) {
    this.builtIn = OPENAI_VOICES.map((v) => ({ ...v, provider: 'openai' as const, previewUrl: `/voices/${v.id}/preview` }));
  }

  /** A built-in voice by id (case-insensitive). */
  get(id: string): VoiceInfo | undefined {
    const wanted = id.trim().toLowerCase();
    return this.builtIn.find((v) => v.id.toLowerCase() === wanted);
  }

  /** Any voice by id, built-in or from a provider. */
  async find(id: string): Promise<VoiceInfo | undefined> {
    const builtIn = this.get(id);
    if (builtIn) return builtIn;
    const provider = /^([a-z0-9]+):/i.exec(id.trim())?.[1]?.toLowerCase();
    const source = this.sources.find((s) => s.provider === provider);
    return source ? source.find(id.trim()) : undefined;
  }

  /** Built-in voices only (no network). */
  list(filter: VoiceFilter = {}): VoiceInfo[] {
    return this.builtIn.filter((v) => matches(v, filter));
  }

  /** Every voice on offer: built-in ones plus each provider's, filtered the same way. */
  async listAll(filter: VoiceFilter = {}): Promise<VoiceInfo[]> {
    const wanted = filter.provider?.trim().toLowerCase();
    const fromSources = await Promise.all(
      this.sources.filter((s) => !wanted || s.provider === wanted).map((s) => s.list(filter).then((list) => list.filter((v) => matches(v, filter)))),
    );
    return [...this.list(filter), ...fromSources.flat()];
  }

  notes(): string[] {
    return this.sources.flatMap((s) => s.notes());
  }

  /** The distinct values worth filtering on, for a picker UI or an agent. */
  facets(voices: VoiceInfo[] = this.builtIn): { genders: string[]; accents: string[]; providers: string[] } {
    const uniq = (values: string[]): string[] => [...new Set(values)].sort();
    return {
      genders: uniq(voices.map((v) => v.gender)),
      accents: uniq([...voices.map((v) => v.accent), ...this.sources.flatMap((s) => s.accents())]),
      providers: uniq(voices.map((v) => v.provider)),
    };
  }
}
