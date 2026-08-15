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
  /** STT endpointing: ms of silence before an utterance is considered done. */
  TRANSCRIBE_SILENCE_MS: z.coerce.number().int().min(150).max(2000).default(250),
  CHAT_MODEL: z.string().default('gpt-4o-mini'),
});

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
  chatModel: string;
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
    chatModel: parsed.CHAT_MODEL,
  };
}
