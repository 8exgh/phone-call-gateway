import { startGateway, post, ControlClient, type Gateway } from './helpers';
import type { TranscriptMessage } from '../../src/protocol/messages';

describe('STT + prosody path', () => {
  let gw: Gateway;

  afterEach(async () => {
    await gw.close();
  });

  async function connectCall(): Promise<ControlClient> {
    await post(`${gw.baseUrl}/numbers`, { areaCode: '415' });
    const call = await post(`${gw.baseUrl}/calls`, { to: '+15551234567' });
    const control = await ControlClient.connect(gw.wsUrl(String(call.json.controlUrl)));
    await control.waitFor((m) => m.type === 'call.state' && m.state === 'active');
    return control;
  }

  it('transcribes utterances with volume, pace, and stutter annotations', async () => {
    const angry = 'I I wa- want to cancel my subscription right now';
    const meek = 'okay fine';
    gw = await startGateway({
      script: [
        { pauseMs: 300 },
        // 10 words in 2000ms voiced = 300 WPM; -10dB peak ~ -13dBFS = loud.
        { speak: { text: angry, durationMs: 2000, amplitudeDb: -10 } },
        { pauseMs: 400 },
        // 2 words in 3000ms voiced = 40 WPM; -40dB peak ~ -43dBFS = whisper.
        { speak: { text: meek, durationMs: 3000, amplitudeDb: -40 } },
        { pauseMs: 400 },
      ],
    });
    const control = await connectCall();

    const first = (await control.waitFor((m) => m.type === 'transcript')) as TranscriptMessage;
    expect(first.text).toBe(angry);
    expect(first.volume.class).toBe('loud');
    expect(first.volume.dbfs).toBeCloseTo(-13, 0);
    expect(first.pace).toEqual({ class: 'fast', wpm: 300 });
    expect(first.stutter).toMatchObject({ detected: true, repetitions: 1, falseStarts: 1 });
    expect(first.confidence).toBe(0.95);
    expect(first.endMs - first.startMs).toBe(2000);

    const second = (await control.waitFor(
      (m) => m.type === 'transcript',
      { count: 2 },
    )) as TranscriptMessage;
    expect(second.text).toBe(meek);
    expect(second.volume.class).toBe('whisper');
    expect(second.pace).toEqual({ class: 'calm', wpm: 40 });
    expect(second.stutter.detected).toBe(false);
    expect(second.endMs - second.startMs).toBe(3000);

    // speech.started/stopped bracket each transcript on the media clock.
    const types = control.events.map((e) => e.type);
    const startedEvents = control.events.filter((e) => e.type === 'speech.started');
    const stoppedEvents = control.events.filter((e) => e.type === 'speech.stopped');
    expect(startedEvents.length).toBeGreaterThanOrEqual(2);
    expect(stoppedEvents.length).toBeGreaterThanOrEqual(2);
    expect(types.indexOf('speech.started')).toBeLessThan(types.indexOf('transcript'));
    expect(types.indexOf('speech.stopped')).toBeLessThan(types.indexOf('transcript'));
    expect((startedEvents[0] as { atMs: number }).atMs).toBe(first.startMs);
    expect((stoppedEvents[0] as { atMs: number }).atMs).toBe(first.endMs);

    // A low-latency delta preceded the full transcript.
    const deltaIndex = types.indexOf('transcript.delta');
    expect(deltaIndex).toBeGreaterThanOrEqual(0);
    expect(deltaIndex).toBeLessThan(types.indexOf('transcript'));

    control.send({ type: 'hangup' });
    await control.waitFor((m) => m.type === 'call.state' && m.state === 'ended');
    control.close();
  });

  it('detects choppy delivery via audio bursts', async () => {
    gw = await startGateway({
      script: [
        { pauseMs: 300 },
        { speak: { text: 'please stop calling me', durationMs: 2200, amplitudeDb: -22, choppy: true } },
        { pauseMs: 400 },
      ],
    });
    const control = await connectCall();

    const transcript = (await control.waitFor((m) => m.type === 'transcript')) as TranscriptMessage;
    expect(transcript.stutter.choppiness).toBeGreaterThan(0.5);
    expect(transcript.stutter.detected).toBe(true);
    // Text itself is clean; the audio pattern alone triggered detection.
    expect(transcript.stutter.repetitions).toBe(0);
    expect(transcript.stutter.falseStarts).toBe(0);

    control.send({ type: 'hangup' });
    await control.waitFor((m) => m.type === 'call.state' && m.state === 'ended');
    control.close();
  });
});
