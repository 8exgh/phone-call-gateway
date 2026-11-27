import { z } from 'zod';

const envSchema = z.object({
  MODE: z.enum(['mock', 'live']).default('mock'),
  PORT: z.coerce.number().int().positive().default(3300),
  PUBLIC_WSS_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_API_KEY_SID: z.string().optional(),
  TWILIO_API_KEY_SECRET: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  TTS_MODEL: z.string().default('gpt-4o-mini-tts'),
  TTS_VOICE: z.string().default('alloy'),
  TRANSCRIBE_MODEL: z.string().default('gpt-4o-mini-transcribe'),
  /** ISO-639-1 hint for STT; empty string = auto-detect. */
  TRANSCRIBE_LANGUAGE: z.string().default('en'),
  /**
   * STT endpointing: ms of silence before an utterance is considered done.
   * 250 proved too eager for thoughtful speakers (mid-sentence cutoffs).
   */
  TRANSCRIBE_SILENCE_MS: z.coerce.number().int().min(150).max(2000).default(450),
  CHAT_MODEL: z.string().default('gpt-4o-mini'),
  /**
   * classic: transcribe -> chat model -> text-to-speech, one sentence at a time.
   * realtime: caller audio straight into a speech-to-speech model and its
   * voice straight back, with the gateway deciding turn-taking (much faster).
   */
  VOICE_ENGINE: z.enum(['classic', 'realtime']).default('classic'),
  REALTIME_MODEL: z.string().default('gpt-realtime-1.5'),
  /** Reasoning effort for realtime models that reason (gpt-realtime-2.x): minimal is fastest. Empty = model default. */
  REALTIME_REASONING: z.string().optional(),
  REALTIME_VOICE: z.string().default('marin'),
  /** Enables ElevenLabs voices (ids "elevenlabs:<voice_id>") for the realtime engine. */
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_MODEL: z.string().default('eleven_flash_v2_5'),
  /** JSON object overriding turn-taking timings (see TurnTuning), e.g. {"speculateAfterMs":160}. */
  VOICE_TUNING: z.string().optional(),
  /** Standing goal for answering incoming calls; empty = reject incoming calls. */
  INBOUND_GOAL: z.string().optional(),
  INBOUND_OPENING_LINE: z.string().optional(),
  /**
   * Admin password. When set, all client endpoints require a bearer token
   * (this admin key, or a per-client key minted via POST /clients).
   * Unset = open single-tenant mode.
   */
  ADMIN_API_KEY: z.string().optional(),
  /** Where durable state (client registry) lives; mount a volume here. */
  DATA_DIR: z.string().default('./data'),
});

function parseTuning(raw: string | undefined): Record<string, number> | undefined {
  if (!raw || !raw.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('VOICE_TUNING must be a JSON object of numbers');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('VOICE_TUNING must be a JSON object of numbers');
  }
  const out: Record<string, number> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`VOICE_TUNING.${key} must be a number`);
    out[key] = v;
  }
  return out;
}

export interface AppConfig {
  mode: 'mock' | 'live';
  port: number;
  /** Public wss:// base URL Twilio uses to reach the media stream endpoint (live mode). */
  publicWssUrl?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  /** API-key auth (preferred over the account auth token; revocable). */
  twilioApiKeySid?: string;
  twilioApiKeySecret?: string;
  twilioFromNumber?: string;
  openAiApiKey?: string;
  ttsModel: string;
  ttsVoice: string;
  transcribeModel: string;
  transcribeLanguage: string;
  transcribeSilenceMs: number;
  inboundGoal?: string;
  inboundOpeningLine?: string;
  adminApiKey?: string;
  dataDir: string;
  chatModel: string;
  voiceEngine: 'classic' | 'realtime';
  realtimeModel: string;
  realtimeReasoning?: string;
  realtimeVoice: string;
  elevenLabsApiKey?: string;
  elevenLabsModel: string;
  /** Turn-taking overrides for the realtime engine. */
  voiceTuning?: Record<string, number>;
}

/**
 * Parse and validate configuration from an env-shaped record. This is the only
 * module that reads process.env; everything else receives an AppConfig.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.parse(env);

  if (parsed.MODE === 'live') {
    const missing: string[] = (
      [
        ['TWILIO_ACCOUNT_SID', parsed.TWILIO_ACCOUNT_SID],
        ['OPENAI_API_KEY', parsed.OPENAI_API_KEY],
        ['PUBLIC_WSS_URL', parsed.PUBLIC_WSS_URL],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);
    const hasAuthToken = Boolean(parsed.TWILIO_AUTH_TOKEN);
    const hasApiKey = Boolean(parsed.TWILIO_API_KEY_SID && parsed.TWILIO_API_KEY_SECRET);
    if (!hasAuthToken && !hasApiKey) {
      missing.push('TWILIO_AUTH_TOKEN (or TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET)');
    }
    if (missing.length > 0) {
      throw new Error(`MODE=live requires: ${missing.join(', ')}`);
    }
  }

  return {
    mode: parsed.MODE,
    port: parsed.PORT,
    publicWssUrl: parsed.PUBLIC_WSS_URL,
    twilioAccountSid: parsed.TWILIO_ACCOUNT_SID,
    twilioAuthToken: parsed.TWILIO_AUTH_TOKEN,
    twilioApiKeySid: parsed.TWILIO_API_KEY_SID,
    twilioApiKeySecret: parsed.TWILIO_API_KEY_SECRET,
    twilioFromNumber: parsed.TWILIO_FROM_NUMBER,
    openAiApiKey: parsed.OPENAI_API_KEY,
    ttsModel: parsed.TTS_MODEL,
    ttsVoice: parsed.TTS_VOICE,
    transcribeModel: parsed.TRANSCRIBE_MODEL,
    transcribeLanguage: parsed.TRANSCRIBE_LANGUAGE,
    transcribeSilenceMs: parsed.TRANSCRIBE_SILENCE_MS,
    inboundGoal: parsed.INBOUND_GOAL,
    inboundOpeningLine: parsed.INBOUND_OPENING_LINE,
    adminApiKey: parsed.ADMIN_API_KEY || undefined,
    dataDir: parsed.DATA_DIR,
    chatModel: parsed.CHAT_MODEL,
    voiceEngine: parsed.VOICE_ENGINE,
    realtimeModel: parsed.REALTIME_MODEL,
    realtimeReasoning: parsed.REALTIME_REASONING || undefined,
    realtimeVoice: parsed.REALTIME_VOICE,
    elevenLabsApiKey: parsed.ELEVENLABS_API_KEY || undefined,
    elevenLabsModel: parsed.ELEVENLABS_MODEL,
    voiceTuning: parseTuning(parsed.VOICE_TUNING),
  };
}
