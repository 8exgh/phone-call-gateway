import { elevenLabsTtsFactory, pieceEnd, type TtsSocket } from '../../src/speech/elevenLabsTts';

class FakeSocket implements TtsSocket {
  sent: Record<string, unknown>[] = [];
  closed = false;
  private handlers: Record<string, ((data: Buffer | string) => void)[]> = {};
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
  }
  on(event: string, handler: (data: Buffer | string) => void): void {
    (this.handlers[event] ??= []).push(handler);
  }
  fire(event: string, data?: unknown): void {
    for (const h of this.handlers[event] ?? []) h(data === undefined ? '' : JSON.stringify(data));
  }
  texts(context: string): string[] {
    return this.sent.filter((m) => m.context_id === context && typeof m.text === 'string' && m.text !== ' ').map((m) => String(m.text));
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const stream = elevenLabsTtsFactory({ apiKey: 'key' }, () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  })('voice123');
  sockets[0]!.fire('open');
  return { stream, sockets };
}
const audio = (context: string): unknown => ({ audio: Buffer.from([1, 2, 3, 4]).toString('base64'), contextId: context });
const final = (context: string): unknown => ({ audio: null, isFinal: true, contextId: context });

describe('ElevenLabs speech stream', () => {
  it('sends the first sentence as soon as it is written, then the rest as one piece', () => {
    const { stream, sockets } = setup();
    const utterance = stream.begin(() => {}, () => {});
    utterance.push('Sure, I can ');
    expect(sockets[0]!.texts('u1')).toEqual([]);
    utterance.push('help with that. What day ');
    expect(sockets[0]!.texts('u1')).toEqual(['Sure, I can help with that. ']);
    utterance.push('works for you? I have Tuesday ');
    utterance.push('or Thursday.');
    expect(sockets[0]!.texts('u1')).toEqual(['Sure, I can help with that. ']);
    utterance.end();
    expect(sockets[0]!.texts('u1')).toEqual(['Sure, I can help with that. ', 'What day works for you? I have Tuesday or Thursday. ']);
    expect(sockets[0]!.sent.at(-1)).toEqual({ close_context: true, context_id: 'u1' });
  });

  it('speaks a line given whole as a single piece', () => {
    const { stream, sockets } = setup();
    stream.begin(() => {}, () => {}).end('Riverside Dental, this is Ava. How can I help you?');
    expect(sockets[0]!.texts('u1')).toEqual(['Riverside Dental, this is Ava. How can I help you? ']);
  });

  it('does not break a sentence at "p.m." or other abbreviations', () => {
    expect(pieceEnd('We close at one p.m. on Saturday. Anything else', false)).toBe('We close at one p.m. on Saturday.'.length);
    expect(pieceEnd('We open at nine a.m. Would you like', false)).toBe('We open at nine a.m.'.length);
    expect(pieceEnd('We close at one p.m. on', false)).toBe(-1);
    expect(pieceEnd('Sure, I can', true)).toBe(-1);
    expect(pieceEnd('For cancellations we need a full day, or there is a fee', true)).toBe('For cancellations we need a full day,'.length);
    expect(pieceEnd('Is that right? Yes', false)).toBe('Is that right?'.length);
  });

  it('delivers audio to the right utterance and reports when it is complete', () => {
    const { stream, sockets } = setup();
    const heard: number[] = [];
    let done = 0;
    const utterance = stream.begin((bytes) => heard.push(bytes.length), () => done++);
    utterance.push('Hello there.');
    utterance.end();
    sockets[0]!.fire('message', audio('u1'));
    sockets[0]!.fire('message', audio('someone-else'));
    sockets[0]!.fire('message', final('u1'));
    expect(heard).toEqual([4]);
    expect(done).toBe(1);
  });

  it('stops generating a cancelled utterance and delivers nothing more from it', () => {
    const { stream, sockets } = setup();
    const heard: number[] = [];
    const utterance = stream.begin((bytes) => heard.push(bytes.length), () => heard.push(-1));
    utterance.push('We are open Monday to Friday. ');
    utterance.cancel();
    expect(sockets[0]!.sent.at(-1)).toEqual({ context_id: 'u1', close_context: true });
    sockets[0]!.fire('message', audio('u1'));
    sockets[0]!.fire('message', final('u1'));
    expect(heard).toEqual([]);
  });

  it('moves to a fresh connection before a fifth utterance is in flight', () => {
    const { stream, sockets } = setup();
    for (let i = 0; i < 4; i++) stream.begin(() => {}, () => {}).push('Still talking. More. ');
    expect(sockets.length).toBe(1);
    const fifth = stream.begin(() => {}, () => {});
    expect(sockets.length).toBe(2);
    sockets[1]!.fire('open');
    fifth.push('On the new line. ');
    expect(sockets[1]!.texts('u5')).toEqual(['On the new line. ']);
    // the old connection still delivers what it had, and closes when it has finished
    for (const id of ['u1', 'u2', 'u3', 'u4']) sockets[0]!.fire('message', final(id));
    expect(sockets[0]!.closed).toBe(true);
    expect(sockets[1]!.closed).toBe(false);
  });

  it('says an utterance again on a new connection if its connection dies before any sound', () => {
    const { stream, sockets } = setup();
    const heard: number[] = [];
    let done = 0;
    const utterance = stream.begin((bytes) => heard.push(bytes.length), () => done++);
    utterance.push('Hello there. ');
    utterance.end();
    sockets[0]!.fire('close');
    expect(done).toBe(0);
    expect(sockets.length).toBe(2);
    sockets[1]!.fire('open');
    expect(sockets[1]!.texts('u1')).toEqual(['Hello there. ']);
    sockets[1]!.fire('message', audio('u1'));
    sockets[1]!.fire('message', final('u1'));
    expect(heard).toEqual([4]);
    expect(done).toBe(1);
  });

  it('says an utterance again on a new connection if no audio comes back in time', () => {
    jest.useFakeTimers();
    try {
      const { stream, sockets } = setup();
      const heard: number[] = [];
      const utterance = stream.begin((bytes) => heard.push(bytes.length), () => {});
      utterance.push('Hello there. ');
      utterance.end();
      jest.advanceTimersByTime(1400);
      expect(sockets.length).toBe(1);
      jest.advanceTimersByTime(200); // silence for 1.5s: try elsewhere
      expect(sockets.length).toBe(2);
      sockets[1]!.fire('open');
      expect(sockets[1]!.texts('u1')).toEqual(['Hello there. ']);
      expect(sockets[0]!.closed).toBe(true);
      sockets[1]!.fire('message', audio('u1'));
      expect(heard).toEqual([4]);
      // and it is only ever re-sent once
      jest.advanceTimersByTime(5000);
      expect(sockets.length).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('ends an utterance that was cut off part-way instead of hanging', () => {
    const { stream, sockets } = setup();
    let done = 0;
    const utterance = stream.begin(() => {}, () => done++);
    utterance.push('Hello there. ');
    sockets[0]!.fire('message', audio('u1'));
    sockets[0]!.fire('error');
    expect(done).toBe(1);
  });
});
