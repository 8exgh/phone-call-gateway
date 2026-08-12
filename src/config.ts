import { z } from 'zod';

const envSchema = z.object({
  MODE: z.enum(['mock', 'live']).default('mock'),
  PORT: z.coerce.number().int().positive().default(3300),
  PUBLIC_WSS_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  TTS_MODEL: z.string().default('gpt-4o-mini-tts'),
  TTS_VOICE: z.string().default('alloy'),
  TRANSCRIBE_MODEL: z.string().default('gpt-4o-mini-transcribe'),
  CHAT_MODEL: z.string().default('gpt-4o-mini'),
});

export interface AppConfig {
  mode: 'mock' | 'live';
  port: number;
  /** Public wss:// base URL Twilio uses to reach the media stream endpoint (live mode). */
  publicWssUrl?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromNumber?: string;
  openAiApiKey?: string;
  ttsModel: string;
  ttsVoice: string;
  transcribeModel: string;
  chatModel: string;
}

/**
 * Parse and validate configuration from an env-shaped record. This is the only
 * module that reads process.env; everything else receives an AppConfig.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.parse(env);

  if (parsed.MODE === 'live') {
    const missing = (
      [
        ['TWILIO_ACCOUNT_SID', parsed.TWILIO_ACCOUNT_SID],
        ['TWILIO_AUTH_TOKEN', parsed.TWILIO_AUTH_TOKEN],
        ['OPENAI_API_KEY', parsed.OPENAI_API_KEY],
        ['PUBLIC_WSS_URL', parsed.PUBLIC_WSS_URL],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);
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
    twilioFromNumber: parsed.TWILIO_FROM_NUMBER,
    openAiApiKey: parsed.OPENAI_API_KEY,
    ttsModel: parsed.TTS_MODEL,
    ttsVoice: parsed.TTS_VOICE,
    transcribeModel: parsed.TRANSCRIBE_MODEL,
    chatModel: parsed.CHAT_MODEL,
  };
}
