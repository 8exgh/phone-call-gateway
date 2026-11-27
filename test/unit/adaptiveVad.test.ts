import { AdaptiveVad } from '../../src/realtime/adaptiveVad';

function frame(amplitude: number, noise = 0): Int16Array {
  const pcm = new Int16Array(160);
  for (let i = 0; i < 160; i++) {
    pcm[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 200 * i) / 8000) + noise * (Math.random() * 2 - 1));
  }
  return pcm;
}

describe('AdaptiveVad', () => {
  it('declares speech after 60ms of loud audio and reports silence after it', () => {
    const vad = new AdaptiveVad();
    for (let i = 0; i < 20; i++) expect(vad.push(frame(0)).started).toBe(false);
    expect(vad.push(frame(4000)).started).toBe(false);
    expect(vad.push(frame(4000)).started).toBe(false);
    expect(vad.push(frame(4000)).started).toBe(true);
    expect(vad.inSpeech).toBe(true);
    expect(vad.silenceMs).toBe(0);
    for (let i = 0; i < 10; i++) vad.push(frame(0));
    expect(vad.silenceMs).toBe(200);
  });

  it('does not mistake steady line noise for speech, even from the first moment, but hears speech over it', () => {
    const vad = new AdaptiveVad();
    let onsets = 0;
    for (let i = 0; i < 500; i++) {
      if (vad.push(frame(0, 700)).started) onsets++;
    }
    expect(onsets).toBe(0);
    let heard = false;
    for (let i = 0; i < 10; i++) heard = vad.push(frame(5000, 700)).started || heard;
    expect(heard).toBe(true);
  });

  it('a long utterance does not raise the floor enough to hide itself', () => {
    const vad = new AdaptiveVad();
    for (let i = 0; i < 20; i++) vad.push(frame(0, 60));
    let quietFrames = 0;
    // 8 seconds of speech with a short dip every 400ms, as real speech has
    for (let i = 0; i < 400; i++) {
      const dip = i % 20 >= 18;
      const { loud } = vad.push(frame(dip ? 0 : 3000, 60));
      if (!dip && !loud) quietFrames++;
    }
    expect(quietFrames).toBe(0);
  });

  it('ignores blanked (echo-suppressed) frames when judging the background level', () => {
    const vad = new AdaptiveVad();
    for (let i = 0; i < 150; i++) vad.push(frame(0, 700));
    // While our own audio plays, inbound frames are blanked. They must not teach
    // the detector that the line is silent, or the noise would then read as speech.
    for (let i = 0; i < 150; i++) vad.push(new Int16Array(160), true);
    let onsets = 0;
    for (let i = 0; i < 100; i++) if (vad.push(frame(0, 700)).started) onsets++;
    expect(onsets).toBe(0);
  });
});
