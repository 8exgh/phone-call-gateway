import { z } from 'zod';

/**
 * The control WebSocket protocol — the API an orchestrating client (usually an
 * LLM harness) consumes. Single source of truth: the server, the orchestrator,
 * and the tests all import these schemas.
 */

// ---------- Client -> server ----------

export const sayMessageSchema = z.object({
  type: z.literal('say'),
  /** Client-chosen id, echoed back in say.* lifecycle events. */
  id: z.string().min(1),
  text: z.string().min(1),
  /** OpenAI TTS voice override (defaults to server config). */
  voice: z.string().optional(),
  /** OpenAI TTS style instructions, e.g. "warm and upbeat, medium pace". */
  instructions: z.string().optional(),
});

export const clearMessageSchema = z.object({
  type: z.literal('clear'),
});

export const hangupMessageSchema = z.object({
  type: z.literal('hangup'),
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  sayMessageSchema,
  clearMessageSchema,
  hangupMessageSchema,
]);

export type SayMessage = z.infer<typeof sayMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---------- Server -> client ----------

export const callStateSchema = z.enum(['created', 'dialing', 'active', 'ending', 'ended', 'failed']);
export type CallState = z.infer<typeof callStateSchema>;

export const callStateMessageSchema = z.object({
  type: z.literal('call.state'),
  callId: z.string(),
  state: callStateSchema,
  reason: z.string().optional(),
});

export const sayStartedMessageSchema = z.object({
  type: z.literal('say.started'),
  id: z.string(),
});

/** Emitted on the Twilio mark acknowledgement: playback actually finished. */
export const sayCompletedMessageSchema = z.object({
  type: z.literal('say.completed'),
  id: z.string(),
});

export const sayAbortedMessageSchema = z.object({
  type: z.literal('say.aborted'),
  id: z.string(),
  reason: z.enum(['clear', 'hangup', 'error']),
});

export const speechStartedMessageSchema = z.object({
  type: z.literal('speech.started'),
  atMs: z.number(),
});

export const speechStoppedMessageSchema = z.object({
  type: z.literal('speech.stopped'),
  atMs: z.number(),
});

export const transcriptMessageSchema = z.object({
  type: z.literal('transcript'),
  text: z.string(),
  /** Media-clock milliseconds (Twilio frame count x 20ms). */
  startMs: z.number(),
  endMs: z.number(),
  pace: z.object({
    class: z.enum(['calm', 'slow', 'normal', 'fast']),
    wpm: z.number().nullable(),
  }),
  volume: z.object({
    class: z.enum(['whisper', 'normal', 'loud', 'yell']),
    dbfs: z.number(),
  }),
  stutter: z.object({
    detected: z.boolean(),
    repetitions: z.number(),
    falseStarts: z.number(),
    choppiness: z.number(),
  }),
  confidence: z.number().optional(),
});

export const transcriptDeltaMessageSchema = z.object({
  type: z.literal('transcript.delta'),
  text: z.string(),
});

export const errorMessageSchema = z.object({
  type: z.literal('error'),
  code: z.enum([
    'invalid_message',
    'call_failed',
    'tts_failed',
    'stt_failed',
    'control_busy',
    'unknown_call',
  ]),
  message: z.string(),
});

export const serverMessageSchema = z.discriminatedUnion('type', [
  callStateMessageSchema,
  sayStartedMessageSchema,
  sayCompletedMessageSchema,
  sayAbortedMessageSchema,
  speechStartedMessageSchema,
  speechStoppedMessageSchema,
  transcriptMessageSchema,
  transcriptDeltaMessageSchema,
  errorMessageSchema,
]);

export type CallStateMessage = z.infer<typeof callStateMessageSchema>;
export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>;
export type ErrorMessage = z.infer<typeof errorMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

// ---------- Parsing helpers ----------

export type ParseResult<T> = { ok: true; message: T } | { ok: false; error: string };

function parseJson(raw: string): ParseResult<unknown> {
  try {
    return { ok: true, message: JSON.parse(raw) };
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
}

export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  const json = parseJson(raw);
  if (!json.ok) return json;
  const result = clientMessageSchema.safeParse(json.message);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, message: result.data };
}

export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  const json = parseJson(raw);
  if (!json.ok) return json;
  const result = serverMessageSchema.safeParse(json.message);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, message: result.data };
}
