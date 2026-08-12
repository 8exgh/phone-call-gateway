import {
  parseClientMessage,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from '../../src/protocol/messages';

describe('control protocol', () => {
  const clientMessages: ClientMessage[] = [
    { type: 'say', id: 's1', text: 'Hello there!' },
    { type: 'say', id: 's2', text: 'Hi', voice: 'ash', instructions: 'calm and warm' },
    { type: 'clear' },
    { type: 'hangup' },
  ];

  const serverMessages: ServerMessage[] = [
    { type: 'call.state', callId: 'c1', state: 'dialing' },
    { type: 'call.state', callId: 'c1', state: 'failed', reason: 'busy' },
    { type: 'say.started', id: 's1' },
    { type: 'say.completed', id: 's1' },
    { type: 'say.aborted', id: 's2', reason: 'clear' },
    { type: 'speech.started', atMs: 1200 },
    { type: 'speech.stopped', atMs: 3400 },
    {
      type: 'transcript',
      text: 'I I wa- want to cancel',
      startMs: 1200,
      endMs: 3400,
      pace: { class: 'fast', wpm: 182 },
      volume: { class: 'loud', dbfs: -14.2 },
      stutter: { detected: true, repetitions: 1, falseStarts: 1, choppiness: 0.4 },
      confidence: 0.93,
    },
    {
      type: 'transcript',
      text: 'silence case',
      startMs: 0,
      endMs: 0,
      pace: { class: 'normal', wpm: null },
      volume: { class: 'whisper', dbfs: -96 },
      stutter: { detected: false, repetitions: 0, falseStarts: 0, choppiness: 0 },
    },
    { type: 'transcript.delta', text: 'I I wa-' },
    { type: 'error', code: 'tts_failed', message: 'upstream 500' },
  ];

  it.each(clientMessages.map((m) => [m.type, m] as const))(
    'round-trips client message %s',
    (_type, message) => {
      const result = parseClientMessage(JSON.stringify(message));
      expect(result).toEqual({ ok: true, message });
    },
  );

  it.each(serverMessages.map((m, i) => [`${m.type}#${i}`, m] as const))(
    'round-trips server message %s',
    (_label, message) => {
      const result = parseServerMessage(JSON.stringify(message));
      expect(result).toEqual({ ok: true, message });
    },
  );

  it('rejects invalid JSON', () => {
    expect(parseClientMessage('{nope')).toEqual({ ok: false, error: 'not valid JSON' });
  });

  it('rejects unknown message types', () => {
    const result = parseClientMessage(JSON.stringify({ type: 'shout', text: 'hi' }));
    expect(result.ok).toBe(false);
  });

  it('rejects a say without text with a useful error', () => {
    const result = parseClientMessage(JSON.stringify({ type: 'say', id: 's1' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('text');
  });

  it('rejects a transcript with an invalid pace class', () => {
    const bad = {
      type: 'transcript',
      text: 'x',
      startMs: 0,
      endMs: 1,
      pace: { class: 'frantic', wpm: 400 },
      volume: { class: 'loud', dbfs: -10 },
      stutter: { detected: false, repetitions: 0, falseStarts: 0, choppiness: 0 },
    };
    expect(parseServerMessage(JSON.stringify(bad)).ok).toBe(false);
  });
});
