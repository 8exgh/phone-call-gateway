import WebSocket from 'ws';

/**
 * Hears the first words of whatever a caller says while the agent is talking,
 * about half a second after they start, so the agent can tell "mm-hmm" from
 * "wait, sorry". Audio is fed only while the agent is speaking.
 */
export interface WordSpotter {
  /** One inbound 20ms mu-law frame. */
  feed(mulaw: Uint8Array): void;
  /** Forget what has been heard: the next words start a fresh window. */
  reset(): void;
  /** Called with everything heard since the last reset, each time it grows. */
  onText(handler: (text: string) => void): void;
  close(): void;
}

export type WordSpotterFactory = () => WordSpotter;

const HUMS = /^(m+|m+h+m+|mhm+|mm+-?h+m+|u+h+-?h+u+h+|uhuh|a+h+a+|a+h+|o+h+|h+m+|huh|u+m+|u+h+|e+r+m*)$/;
const SOFT = new Set(['yeah', 'yep', 'yes', 'yup', 'ok', 'okay', 'right', 'sure', 'alright', 'cool', 'great', 'good', 'nice', 'perfect', 'wow', 'true', 'exactly', 'i', 'see', 'got', 'it', 'gotcha']);

export type OverlapKind =
  /** Nothing recognisable yet. */
  | 'none'
  /** Pure listening noise ("mm-hmm", "uh-huh"): carry on, nothing to answer. */
  | 'hum'
  /** A word of agreement ("yeah", "okay", "got it"): carry on, but it may be an answer. */
  | 'agreement'
  /** Real words: they want the floor. */
  | 'words';

/** What kind of thing did the caller say over the agent? (English.) */
export function classifyOverlap(text: string): OverlapKind {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z'\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return 'none';
  let agreement = false;
  for (const token of tokens) {
    if (HUMS.test(token)) continue;
    if (SOFT.has(token)) {
      agreement = true;
      continue;
    }
    return 'words';
  }
  // "I see" / "got it" only count whole: a lone "I" or "it" is the start of a sentence.
  const phrase = tokens.filter((t) => !HUMS.test(t)).join(' ');
  if (/\b(i|see|got|it)\b/.test(phrase) && !/\b(i see|got it)\b/.test(phrase)) return 'words';
  return agreement ? 'agreement' : 'hum';
}

/** OpenAI streaming transcription (words arrive while the person is still speaking). */
export function openAiWordSpotterFactory(apiKey: string, model = 'gpt-live-transcribe', language = 'en'): WordSpotterFactory {
  return () => {
    const ws = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    let ready = false;
    let closed = false;
    let handler: ((text: string) => void) | null = null;
    let text = '';
    let currentItem: string | null = null;
    const stale = new Set<string>();
    let fedSinceReset = 0;
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            type: 'transcription',
            audio: {
              input: {
                format: { type: 'audio/pcmu' },
                transcription: { model, ...(language ? { language } : {}), delay: 'minimal' },
                turn_detection: null,
              },
            },
          },
        }),
      );
      ready = true;
    });
    ws.on('message', (data: Buffer | string) => {
      let msg: { type?: string; item_id?: string; delta?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type !== 'conversation.item.input_audio_transcription.delta' || !msg.delta) return;
      const item = msg.item_id ?? '';
      if (stale.has(item)) return;
      currentItem = item;
      text += msg.delta;
      handler?.(text);
    });
    ws.on('error', () => {
      ready = false;
    });
    ws.on('close', () => {
      ready = false;
    });
    return {
      feed(mulaw) {
        if (!ready || closed) return;
        fedSinceReset++;
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.from(mulaw).toString('base64') }));
      },
      reset() {
        if (currentItem !== null) stale.add(currentItem);
        currentItem = null;
        text = '';
        // Close off what was heard so the next words form a new item.
        if (ready && !closed && fedSinceReset >= 10) ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        fedSinceReset = 0;
      },
      onText(h) {
        handler = h;
      },
      close() {
        closed = true;
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      },
    };
  };
}
