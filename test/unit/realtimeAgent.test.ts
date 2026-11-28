import { RealtimeAgent, clearCannedAudioCache, type RealtimeAgentOptions } from '../../src/realtime/realtimeAgent';
import type { RealtimeSocket } from '../../src/realtime/realtimeSocket';
import type { CallSession, MediaTap } from '../../src/call/callSession';
import type { CallResult } from '../../src/orchestrator/orchestrator';
import { encode as mulawEncode } from '../../src/audio/mulaw';
import type { TtsStream } from '../../src/speech/ttsStream';

/** The model's end of the wire: records what the agent sends, lets a test play the model. */
class FakeSocket implements RealtimeSocket {
  sent: Record<string, unknown>[] = [];
  closed = false;
  private openHandler: (() => void) | null = null;
  private eventHandler: ((event: Record<string, unknown>) => void) | null = null;
  private closedHandler: ((reason: string) => void) | null = null;
  send(event: Record<string, unknown>): void {
    this.sent.push(event);
  }
  close(): void {
    this.closed = true;
  }
  onOpen(handler: () => void): void {
    this.openHandler = handler;
  }
  onEvent(handler: (event: Record<string, unknown>) => void): void {
    this.eventHandler = handler;
  }
  onClosed(handler: (reason: string) => void): void {
    this.closedHandler = handler;
  }
  open(): void {
    this.openHandler?.();
  }
  emit(event: Record<string, unknown>): void {
    this.eventHandler?.(event);
  }
  drop(reason: string): void {
    this.closedHandler?.(reason);
  }
  count(type: string): number {
    return this.sent.filter((e) => e.type === type).length;
  }
  last(type: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((e) => e.type === type);
  }
}

/** The phone line's end: what was played, marks requested, clears, hangup. */
class FakeLine {
  tap: MediaTap | null = null;
  written: Uint8Array[] = [];
  marks: string[] = [];
  clears = 0;
  hungUp = false;
  session(): CallSession {
    return {
      attachTap: (tap: MediaTap) => {
        this.tap = tap;
      },
      tapWrite: (frame: Uint8Array) => {
        this.written.push(frame);
      },
      tapMark: (name: string) => {
        this.marks.push(name);
      },
      tapClear: () => {
        this.clears++;
      },
      hangup: async () => {
        this.hungUp = true;
      },
    } as unknown as CallSession;
  }
  /** Twilio reports everything played. */
  ackLastMark(): void {
    this.tap!.onMark(this.marks[this.marks.length - 1]!);
  }
}

function tone(ms: number, amplitude: number): Uint8Array {
  const pcm = new Int16Array(ms * 8);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / 8000));
  return mulawEncode(pcm);
}
function frames(ms: number, amplitude: number): Uint8Array[] {
  const bytes = tone(ms, amplitude);
  const out: Uint8Array[] = [];
  for (let i = 0; i + 160 <= bytes.length; i += 160) out.push(bytes.subarray(i, i + 160));
  return out;
}
const speech = (ms: number): Uint8Array[] => frames(ms, 6000);
const silence = (ms: number): Uint8Array[] => frames(ms, 0);

let responseSeq = 0;
/** Play the model answering the pending response.create. */
function modelAnswers(
  socket: FakeSocket,
  opts: { audioMs?: number; text?: string; calls?: { name: string; args?: string }[]; status?: string } = {},
): string {
  const id = `resp_${++responseSeq}`;
  socket.emit({ type: 'response.created', response: { id } });
  if (opts.audioMs) {
    socket.emit({ type: 'response.output_item.added', response_id: id, item: { id: `msg_${responseSeq}`, type: 'message' } });
    socket.emit({ type: 'response.output_audio.delta', response_id: id, delta: Buffer.from(tone(opts.audioMs, 8000)).toString('base64') });
    socket.emit({ type: 'response.output_audio_transcript.delta', response_id: id, delta: opts.text ?? 'Sure thing.' });
    socket.emit({ type: 'response.output_audio.done', response_id: id });
  }
  (opts.calls ?? []).forEach((call, i) => {
    const item = { id: `fc_${responseSeq}_${i}`, type: 'function_call', call_id: `call_${responseSeq}_${i}`, name: call.name, arguments: call.args ?? '{}' };
    socket.emit({ type: 'response.output_item.added', response_id: id, item });
    socket.emit({ type: 'response.output_item.done', response_id: id, item });
  });
  socket.emit({ type: 'response.done', response: { id, status: opts.status ?? 'completed' } });
  return id;
}

interface Call {
  agent: RealtimeAgent;
  socket: FakeSocket;
  line: FakeLine;
  result: Promise<CallResult>;
  timeline: string[];
  feed(audio: Uint8Array[]): void;
  /** Caller says something, pauses, and the model's reply is heard to its end. */
  exchange(replyMs: number, text?: string): void;
  end(): Promise<CallResult>;
}

/** A connected call whose greeting has already been spoken and heard. */
function startCall(overrides: Partial<RealtimeAgentOptions> = {}): Call {
  const socket = new FakeSocket();
  const line = new FakeLine();
  const timeline: string[] = [];
  const agent = new RealtimeAgent({
    session: line.session(),
    socketFactory: () => socket,
    model: 'test-model',
    defaultVoice: 'marin',
    language: 'en',
    systemPrompt: 'You are a test receptionist.',
    openingLine: 'Hello, test line.',
    onTimeline: (text) => timeline.push(text),
    ...overrides,
  });
  const result = agent.run();
  socket.open();
  socket.emit({ type: 'session.updated' });
  if (socket.count('response.create') > 0) modelAnswers(socket, { audioMs: 400 });
  line.tap!.onStart();
  const feed = (audio: Uint8Array[]): void => {
    for (const frame of audio) {
      line.tap!.onFrame(frame);
      jest.advanceTimersByTime(20);
    }
  };
  if (line.marks.length > 0) line.ackLastMark();
  feed(silence(300)); // the line is quiet for a moment before anyone speaks
  return {
    agent,
    socket,
    line,
    result,
    timeline,
    feed,
    exchange(replyMs, text) {
      feed(speech(600));
      feed(silence(160));
      socket.emit({ type: 'input_audio_buffer.committed', item_id: `user_${++responseSeq}` });
      modelAnswers(socket, { audioMs: replyMs, text });
      feed(silence(700));
    },
    async end() {
      line.tap!.onClosed('ended', 'remote_hangup');
      return result;
    },
  };
}

/** A speech engine that turns each utterance into 20ms of tone per character once it ends. */
class FakeTts implements TtsStream {
  spoken: string[] = [];
  cancelled = 0;
  closed = false;
  begin(onAudio: (mulaw: Uint8Array) => void, onDone: () => void) {
    let text = '';
    let over = false;
    return {
      push: (more: string) => {
        text += more;
      },
      end: (finalText?: string) => {
        if (over) return;
        over = true;
        text += finalText ?? '';
        this.spoken.push(text);
        // Like the real engine: nothing to say, no sound.
        if (text.trim()) onAudio(tone(text.length * 20, 8000));
        onDone();
      },
      cancel: () => {
        over = true;
        this.cancelled++;
      },
    };
  }
  close(): void {
    this.closed = true;
  }
}

describe('RealtimeAgent', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    clearCannedAudioCache();
    responseSeq = 0;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('configures the model with its own turn detection off and speaks the greeting once the line connects', async () => {
    const call = startCall();
    const session = (call.socket.sent[0]!.session ?? {}) as { audio: { input: { turn_detection: unknown; format: unknown } } };
    expect(call.socket.sent[0]!.type).toBe('session.update');
    expect(session.audio.input.turn_detection).toBeNull();
    expect(session.audio.input.format).toEqual({ type: 'audio/pcmu' });
    // 400ms greeting = 20 frames on the line, and it is recorded as the agent's first turn
    expect(call.line.written.length).toBe(20);
    const result = await call.end();
    expect(result.turns[0]).toEqual({ role: 'agent', text: 'Hello, test line.' });
  });

  it('plays a greeting it has spoken before without asking the model again', () => {
    startCall();
    const second = startCall();
    // the first call's greeting was the only one generated
    expect(second.socket.count('response.create')).toBe(0);
    expect(second.line.written.length).toBe(20);
  });

  it('asks for a reply at a short pause but holds it until the caller has had their beat of silence', () => {
    const call = startCall();
    const before = call.line.written.length;
    call.feed(speech(600));
    expect(call.socket.count('input_audio_buffer.commit')).toBe(0);
    call.feed(silence(160));
    expect(call.socket.count('input_audio_buffer.commit')).toBe(1);
    expect(call.socket.count('response.create')).toBe(2); // greeting + this reply
    modelAnswers(call.socket, { audioMs: 1000 });
    call.feed(silence(300)); // 460ms of silence so far: too soon to speak
    expect(call.line.written.length).toBe(before);
    call.feed(silence(300)); // past 700ms
    expect(call.line.written.length).toBe(before + 50);
  });

  it('drops a reply the caller talks through and re-sends their whole turn as one piece', () => {
    const call = startCall();
    const before = call.line.written.length;
    call.feed(speech(600));
    call.feed(silence(200));
    call.socket.emit({ type: 'input_audio_buffer.committed', item_id: 'user_a' });
    call.socket.emit({ type: 'response.created', response: { id: 'resp_slow' } });
    call.feed(speech(300)); // they were not finished
    expect(call.socket.count('response.cancel')).toBe(1);
    expect(call.socket.sent).toContainEqual({ type: 'conversation.item.delete', item_id: 'user_a' });
    expect(call.socket.count('input_audio_buffer.clear')).toBe(1);
    call.socket.emit({ type: 'response.done', response: { id: 'resp_slow', status: 'cancelled' } });
    call.feed(speech(300));
    call.feed(silence(160));
    expect(call.socket.count('input_audio_buffer.commit')).toBe(2);
    expect(call.socket.count('response.create')).toBe(3);
    expect(call.line.written.length).toBe(before); // nothing was said over them
  });

  it('stays quiet when the model judges the caller mid-thought, then answers anyway if they say no more', () => {
    const call = startCall();
    const before = call.line.written.length;
    call.feed(speech(600));
    call.feed(silence(160));
    modelAnswers(call.socket, { calls: [{ name: 'keep_listening' }] });
    expect(call.socket.sent).toContainEqual({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: 'call_2_0', output: 'listening' },
    });
    const creates = call.socket.count('response.create');
    call.feed(silence(1000));
    expect(call.socket.count('response.create')).toBe(creates);
    expect(call.line.written.length).toBe(before);
    call.feed(silence(1700)); // hold expires
    expect(call.socket.count('response.create')).toBe(creates + 1);
  });

  it('overrules the model when it holds on what the transcript shows is a finished question', () => {
    const call = startCall();
    call.feed(speech(900));
    call.feed(silence(160));
    call.socket.emit({ type: 'input_audio_buffer.committed', item_id: 'user_q' });
    modelAnswers(call.socket, { calls: [{ name: 'keep_listening' }] });
    const creates = call.socket.count('response.create');
    call.socket.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user_q',
      transcript: 'So is this call from production?',
    });
    expect(call.timeline).toContain('hold overruled (they asked a question)');
    expect(call.socket.count('response.create')).toBe(creates + 1);
    // if the model insists, it is not overruled a second time for the same turn
    modelAnswers(call.socket, { calls: [{ name: 'keep_listening' }] });
    expect(call.socket.count('response.create')).toBe(creates + 1);
  });

  it('treats what the caller says after a held-then-answered turn as a new turn', () => {
    const call = startCall();
    call.feed(speech(900));
    call.feed(silence(160));
    call.socket.emit({ type: 'input_audio_buffer.committed', item_id: 'user_h' });
    modelAnswers(call.socket, { calls: [{ name: 'keep_listening' }] });
    call.feed(silence(2100)); // hold expires, the model is asked again
    modelAnswers(call.socket, { audioMs: 400, text: 'Sure.' });
    call.feed(silence(100));
    call.line.ackLastMark();
    call.feed(speech(600)); // a fresh utterance
    expect(call.timeline.some((t) => t.startsWith('turn continues'))).toBe(false);
    expect(call.socket.sent).not.toContainEqual({ type: 'conversation.item.delete', item_id: 'user_h' });
  });

  it('holds back a reply when the transcript shows the caller trailed off mid-sentence', () => {
    const call = startCall({ tuning: { patienceMinMs: 1000 } });
    const before = call.line.written.length;
    call.feed(speech(900));
    call.feed(silence(160));
    call.socket.emit({ type: 'input_audio_buffer.committed', item_id: 'user_t' });
    modelAnswers(call.socket, { audioMs: 800 });
    call.socket.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user_t',
      transcript: 'And if I wanted to come in this week, um.',
    });
    call.feed(silence(1000));
    expect(call.line.written.length).toBe(before);
    expect(call.timeline.some((t) => t.startsWith('hold (words trail off'))).toBe(true);
  });

  it('pauses when the caller makes a short sound over it, then picks the sentence back up', () => {
    const call = startCall();
    call.exchange(5000);
    const playing = call.line.written.length;
    call.feed(silence(1000)); // one second into the reply
    call.feed(speech(300)); // "mm-hmm"
    expect(call.line.clears).toBe(1);
    expect(call.timeline.some((t) => t.startsWith('paused at'))).toBe(true);
    call.feed(silence(320));
    expect(call.timeline.some((t) => t.startsWith('resumed from'))).toBe(true);
    expect(call.line.written.length).toBeGreaterThan(playing + 100); // the rest was sent again
    expect(call.socket.count('conversation.item.truncate')).toBe(0);
  });

  it('stops for good when the caller keeps talking over it, and remembers only what was heard', async () => {
    const call = startCall();
    call.exchange(5000, 'We are open Monday to Friday from eight until six and Saturday mornings.');
    call.feed(silence(1000));
    call.feed(speech(900)); // a real interruption
    expect(call.line.clears).toBe(1);
    const truncate = call.socket.last('conversation.item.truncate') as { item_id: string; audio_end_ms: number };
    expect(truncate.item_id).toMatch(/^msg_/);
    expect(truncate.audio_end_ms).toBeGreaterThan(900);
    expect(truncate.audio_end_ms).toBeLessThan(2500);
    const result = await call.end();
    const said = result.turns.filter((t) => t.role === 'agent').pop()!.text;
    expect(said.endsWith('…')).toBe(true);
    expect(said.length).toBeLessThan(60);
  });

  it('yields at once if it had only just started answering and the caller carries on', () => {
    const call = startCall();
    call.exchange(3000);
    call.feed(silence(100)); // 100ms into the reply
    call.feed(speech(160));
    expect(call.line.clears).toBe(1);
    expect(call.timeline.some((t) => t.startsWith('interrupted after'))).toBe(true);
  });

  it('hangs up after its goodbye has been heard when the model ends the call', () => {
    const call = startCall();
    call.feed(speech(600));
    call.feed(silence(160));
    modelAnswers(call.socket, { audioMs: 400, text: 'Goodbye!', calls: [{ name: 'end_call' }] });
    call.feed(silence(700));
    expect(call.line.hungUp).toBe(false);
    call.line.ackLastMark();
    expect(call.line.hungUp).toBe(true);
  });

  it('brokers a tool call: holds the line, then answers with the result', async () => {
    const requests: { id: string; name: string }[] = [];
    const call = startCall({
      tools: [{ name: 'check_calendar', description: 'Look at the calendar' }],
      onToolRequest: (r) => requests.push({ id: r.id, name: r.name }),
    });
    call.feed(speech(600));
    call.feed(silence(160));
    modelAnswers(call.socket, { calls: [{ name: 'check_calendar', args: '{"query":"tomorrow"}' }] });
    expect(requests).toEqual([{ id: 'call_2_0', name: 'check_calendar' }]);
    // a hold line is requested (spoken outside the conversation)
    const hold = call.socket.last('response.create') as { response: { instructions: string; conversation: string } };
    expect(hold.response.conversation).toBe('none');
    expect(hold.response.instructions).toContain('One moment');
    modelAnswers(call.socket, { audioMs: 400 });
    const creates = call.socket.count('response.create');
    expect(call.agent.provideToolResult('call_2_0', 'free after three')).toBe(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(call.socket.sent).toContainEqual({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: 'call_2_0', output: 'free after three' },
    });
    expect(call.socket.count('response.create')).toBe(creates + 1);
  });

  it('promises a callback and hangs up when a tool result does not arrive in time', async () => {
    const timedOut: string[][] = [];
    const call = startCall({
      tools: [{ name: 'check_calendar', description: 'Look at the calendar' }],
      toolTimeoutMs: 5000,
      onToolTimeout: (ids) => timedOut.push(ids),
    });
    call.feed(speech(600));
    call.feed(silence(160));
    modelAnswers(call.socket, { audioMs: 400, text: 'Let me check.', calls: [{ name: 'check_calendar' }] });
    await jest.advanceTimersByTimeAsync(5100);
    expect(timedOut).toEqual([['call_2_0']]);
    const callback = call.socket.last('response.create') as { response: { instructions: string } };
    expect(callback.response.instructions).toContain('call you back immediately');
  });

  it('asks again when the model has produced nothing after a few seconds', () => {
    const call = startCall();
    call.feed(speech(600));
    call.feed(silence(160));
    const creates = call.socket.count('response.create');
    call.socket.emit({ type: 'response.created', response: { id: 'resp_stuck' } });
    call.feed(silence(2600));
    expect(call.socket.count('response.cancel')).toBe(1);
    call.socket.emit({ type: 'response.done', response: { id: 'resp_stuck', status: 'cancelled' } });
    expect(call.socket.count('response.create')).toBe(creates + 1);
  });

  it('asks again when the model answers the caller with nothing, then asks the caller to repeat', () => {
    const call = startCall();
    call.feed(speech(600));
    call.feed(silence(160));
    const creates = call.socket.count('response.create');
    modelAnswers(call.socket, {}); // an empty reply: no speech, no tool call
    expect(call.timeline).toContain('model returned an empty reply: asking again');
    expect(call.socket.count('response.create')).toBe(creates + 1);
    modelAnswers(call.socket, {});
    expect(call.timeline).toContain('model returned an empty reply twice: asking the caller to repeat');
    const line = call.socket.last('response.create') as { response: { instructions: string } };
    expect(line.response.instructions).toContain('could you say that again');
    expect(call.line.hungUp).toBe(false);
  });

  it('stops prompting a line that stays silent: two prompts, then goodbye and hang up', () => {
    const call = startCall({ turnTimeoutMs: 5000 });
    const prompt = (): void => {
      call.feed(silence(5100)); // silence timer fires
      modelAnswers(call.socket, { audioMs: 400, text: 'Are you still there?' });
      call.feed(silence(100));
      call.line.ackLastMark();
    };
    const before = call.socket.count('response.create');
    prompt();
    prompt();
    expect(call.socket.count('response.create')).toBe(before + 2);
    call.feed(silence(5100)); // a third silence: no more prompts
    expect(call.timeline).toContain('line silent after 2 prompts: hanging up');
    const bye = call.socket.last('response.create') as { response: { instructions: string } };
    expect(bye.response.instructions).toContain("I'll hang up now");
    modelAnswers(call.socket, { audioMs: 400 });
    call.feed(silence(100));
    call.line.ackLastMark();
    expect(call.line.hungUp).toBe(true);
  });

  it('counts unanswered prompts afresh once the caller speaks', () => {
    const call = startCall({ turnTimeoutMs: 5000 });
    for (let i = 0; i < 2; i++) {
      call.feed(silence(5100));
      modelAnswers(call.socket, { audioMs: 400, text: 'Are you still there?' });
      call.feed(silence(100));
      call.line.ackLastMark();
    }
    call.exchange(400, 'Good, you are back.');
    call.line.ackLastMark();
    call.feed(silence(5100)); // silent again: this is prompt one, not a hangup
    expect(call.timeline).not.toContain('line silent after 2 prompts: hanging up');
    expect(call.line.hungUp).toBe(false);
  });

  it('ends the call as failed when the model connection is lost', async () => {
    const errors: string[] = [];
    const call = startCall({ onLlmError: (m) => errors.push(m) });
    call.socket.drop('socket closed (1006)');
    expect(call.line.hungUp).toBe(true);
    const result = await call.end();
    expect(result.finalState).toBe('failed');
    expect(result.reason).toContain('llm_failed');
    expect(errors).toEqual(['socket closed (1006)']);
  });

  it('records the conversation in order, joining a turn the caller spoke across a pause', async () => {
    const call = startCall();
    call.feed(speech(600));
    call.feed(silence(160));
    call.socket.emit({ type: 'input_audio_buffer.committed', item_id: 'user_1' });
    call.socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user_1', transcript: 'What time do you close?' });
    modelAnswers(call.socket, { audioMs: 400, text: 'We close at six.' });
    call.feed(silence(700));
    call.line.ackLastMark();
    const result = await call.end();
    expect(result.turns.map((t) => `${t.role}: ${t.text}`)).toEqual([
      'agent: Hello, test line.',
      'caller: What time do you close?',
      'agent: We close at six.',
    ]);
    expect(result.turns[1]!.annotation).toMatch(/^\[volume: /);
  });

  describe('with a word spotter', () => {
    function spotter() {
      let handler: ((text: string) => void) | null = null;
      return {
        fed: 0,
        resets: 0,
        feed() {
          this.fed++;
        },
        reset() {
          this.resets++;
        },
        onText(h: (text: string) => void) {
          handler = h;
        },
        close() {},
        hear(text: string, waitMs = 320) {
          handler?.(text);
          jest.advanceTimersByTime(waitMs);
        },
      };
    }

    it('pauses at a sound, then carries straight on when the word turns out to be "mm-hmm"', () => {
      const ears = spotter();
      const call = startCall({ wordSpotter: ears });
      call.exchange(5000);
      call.feed(silence(1000));
      const written = call.line.written.length;
      call.feed(speech(200)); // the start of "mm-hmm"
      expect(call.line.clears).toBe(1);
      expect(ears.fed).toBeGreaterThan(0);
      ears.hear(' Mmm,');
      expect(call.timeline.some((t) => t.startsWith('listening noise over agent'))).toBe(true);
      expect(call.line.written.length).toBeGreaterThan(written); // resumed without waiting for the sound to end
      call.feed(speech(300)); // the rest of the hum does not pause it again
      expect(call.line.clears).toBe(1);
      expect(call.socket.count('conversation.item.truncate')).toBe(0);
    });

    it('waits for a fragment to become a word before judging it ("A" ... "ha,")', () => {
      const ears = spotter();
      const call = startCall({ wordSpotter: ears });
      call.exchange(5000);
      call.feed(silence(1000));
      call.feed(speech(200));
      ears.hear(' A', 400); // not yet a word
      expect(call.timeline.some((t) => t.startsWith('caller took the floor'))).toBe(false);
      ears.hear(' Aha,', 0);
      jest.advanceTimersByTime(1);
      expect(call.timeline.some((t) => t.startsWith('listening noise over agent'))).toBe(true);
      expect(call.socket.count('conversation.item.truncate')).toBe(0);
    });

    it('stops for good as soon as the caller says a real word, even a single one', () => {
      const ears = spotter();
      const call = startCall({ wordSpotter: ears });
      call.exchange(5000);
      call.feed(silence(1000));
      call.feed(speech(300)); // "Wait."
      const commits = call.socket.count('input_audio_buffer.commit');
      const creates = call.socket.count('response.create');
      call.feed(silence(260)); // they said one word and stopped
      ears.hear(' Wait.');
      expect(call.timeline.some((t) => t.startsWith('caller took the floor: "Wait."'))).toBe(true);
      expect(call.socket.count('conversation.item.truncate')).toBe(1);
      // their one word is their turn: it is put to the model and answered
      expect(call.socket.count('input_audio_buffer.commit')).toBe(commits + 1);
      expect(call.socket.count('response.create')).toBe(creates + 1);
    });

    it('does not pick back up until the first word has had time to arrive', () => {
      const ears = spotter();
      const call = startCall({ wordSpotter: ears });
      call.exchange(5000);
      call.feed(silence(1000));
      call.feed(speech(200)); // a sound, then quiet
      expect(call.line.clears).toBe(1);
      call.feed(silence(280)); // quiet for 280ms: its word could still be on the way
      expect(call.timeline.some((t) => t.startsWith('resumed from'))).toBe(false);
      call.feed(silence(200)); // no word came: carry on
      expect(call.timeline.some((t) => t.startsWith('resumed from'))).toBe(true);
    });

    it('treats "yeah" said over it as an answer once it has finished speaking', () => {
      const ears = spotter();
      const call = startCall({ wordSpotter: ears });
      call.exchange(2000);
      call.feed(silence(600));
      call.feed(speech(240));
      ears.hear(' Yeah.');
      call.feed(silence(400));
      const commits = call.socket.count('input_audio_buffer.commit');
      const creates = call.socket.count('response.create');
      call.feed(silence(1500));
      call.line.ackLastMark(); // the agent's reply has been heard to the end
      expect(call.socket.count('input_audio_buffer.commit')).toBe(commits + 1);
      expect(call.socket.count('response.create')).toBe(creates + 1);
    });
  });

  describe('with an outside voice (text-to-speech)', () => {
    it('asks the model for text, has the speech engine read the greeting itself, and speaks replies as they are written', async () => {
      const tts = new FakeTts();
      const call = startCall({ tts: { stream: tts, key: 'elevenlabs:test' } });
      const session = (call.socket.sent[0]!.session ?? {}) as { output_modalities: string[]; instructions: string };
      expect(session.output_modalities).toEqual(['text']);
      expect(session.instructions).toContain('reads aloud exactly as written');
      // the greeting never went to the model
      expect(call.socket.count('response.create')).toBe(0);
      expect(tts.spoken).toEqual(['Hello, test line.']);
      expect(call.line.written.length).toBe('Hello, test line.'.length);

      const before = call.line.written.length;
      call.feed(speech(600));
      call.feed(silence(160));
      call.socket.emit({ type: 'response.created', response: { id: 'resp_t' } });
      call.socket.emit({ type: 'response.output_item.added', response_id: 'resp_t', item: { id: 'msg_t', type: 'message' } });
      call.socket.emit({ type: 'response.output_text.delta', response_id: 'resp_t', delta: 'We close ' });
      call.socket.emit({ type: 'response.output_text.delta', response_id: 'resp_t', delta: 'at six.' });
      call.socket.emit({ type: 'response.output_text.done', response_id: 'resp_t' });
      call.socket.emit({ type: 'response.done', response: { id: 'resp_t', status: 'completed' } });
      expect(tts.spoken[1]).toBe('We close at six.');
      call.feed(silence(700));
      expect(call.line.written.length).toBe(before + 'We close at six.'.length);
      call.line.ackLastMark();
      const result = await call.end();
      expect(result.turns.map((t) => t.text)).toEqual(['Hello, test line.', 'We close at six.']);
      expect(tts.closed).toBe(true);
    });

    it('when interrupted, stops the speech engine and tells the model only what was heard', () => {
      const tts = new FakeTts();
      const call = startCall({ tts: { stream: tts, key: 'elevenlabs:test' } });
      const long = 'We are open Monday to Friday from eight until six, and on Saturday mornings from nine until one, closed Sundays and holidays, all year round.';
      call.feed(speech(600));
      call.feed(silence(160));
      call.socket.emit({ type: 'response.created', response: { id: 'resp_l' } });
      call.socket.emit({ type: 'response.output_item.added', response_id: 'resp_l', item: { id: 'msg_l', type: 'message' } });
      call.socket.emit({ type: 'response.output_text.delta', response_id: 'resp_l', delta: long });
      call.socket.emit({ type: 'response.output_text.done', response_id: 'resp_l' });
      call.socket.emit({ type: 'response.done', response: { id: 'resp_l', status: 'completed' } });
      call.feed(silence(1700)); // released at 700ms, then a second into the reply
      call.feed(speech(900));
      expect(call.socket.count('conversation.item.truncate')).toBe(0);
      expect(call.socket.sent).toContainEqual({ type: 'conversation.item.delete', item_id: 'msg_l' });
      const replaced = [...call.socket.sent].reverse().find(
        (e) => e.type === 'conversation.item.create' && (e.item as { role?: string }).role === 'assistant',
      ) as { item: { content: { text: string }[] } };
      expect(replaced.item.content[0]!.text.endsWith('…')).toBe(true);
      expect(replaced.item.content[0]!.text.length).toBeLessThan(long.length / 2);
    });

    it('does not blame the speech engine when the model wrote nothing: it asks the model again', () => {
      const tts = new FakeTts();
      const errors: string[] = [];
      const call = startCall({ tts: { stream: tts, key: 'elevenlabs:test' }, onError: (m) => errors.push(m) });
      call.feed(speech(600));
      call.feed(silence(160));
      const creates = call.socket.count('response.create');
      call.socket.emit({ type: 'response.created', response: { id: 'resp_e' } });
      call.socket.emit({ type: 'response.output_item.added', response_id: 'resp_e', item: { id: 'msg_e', type: 'message' } });
      call.socket.emit({ type: 'response.output_text.delta', response_id: 'resp_e', delta: ' ' });
      call.socket.emit({ type: 'response.output_text.done', response_id: 'resp_e' });
      call.socket.emit({ type: 'response.done', response: { id: 'resp_e', status: 'completed' } });
      expect(call.socket.count('response.create')).toBe(creates + 1);
      call.feed(silence(6500));
      expect(errors).toEqual([]);
      expect(call.line.hungUp).toBe(false);
    });

    it('fails the call instead of leaving a silent line when the speech engine produces nothing', async () => {
      const silentTts: TtsStream = { begin: () => ({ push() {}, end() {}, cancel() {} }), close() {} };
      const errors: string[] = [];
      const call = startCall({ tts: { stream: silentTts, key: 'elevenlabs:dead' }, onError: (m) => errors.push(m) });
      call.feed(silence(6200));
      expect(call.line.hungUp).toBe(true);
      expect(errors[0]).toContain('tts_failed');
      const result = await call.end();
      expect(result.finalState).toBe('failed');
    });
  });
});
