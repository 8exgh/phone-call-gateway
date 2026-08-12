import { analyzeStutter, analyzeStutterText, choppiness } from '../../src/prosody/stutter';

describe('stutter text heuristics', () => {
  it('detects immediate word repetitions', () => {
    expect(analyzeStutterText('I I want to cancel')).toEqual({ repetitions: 1, falseStarts: 0 });
    expect(analyzeStutterText('I I I want')).toEqual({ repetitions: 2, falseStarts: 0 });
  });

  it('detects bigram repetitions', () => {
    expect(analyzeStutterText('i want i want to go')).toEqual({ repetitions: 1, falseStarts: 0 });
  });

  it('detects cut-off false starts', () => {
    expect(analyzeStutterText('wa- want to cancel')).toEqual({ repetitions: 0, falseStarts: 1 });
  });

  it('detects short-prefix false starts', () => {
    expect(analyzeStutterText('th the thing is broken')).toEqual({ repetitions: 0, falseStarts: 1 });
  });

  it('does not flag fillers', () => {
    expect(analyzeStutterText('um um yeah uh sure')).toEqual({ repetitions: 0, falseStarts: 0 });
  });

  it('does not flag clean speech', () => {
    expect(analyzeStutterText('hello there, how are you today?')).toEqual({
      repetitions: 0,
      falseStarts: 0,
    });
    // "a" (1 char) before "about" must not count as a false start.
    expect(analyzeStutterText('tell me a about it')).toEqual({ repetitions: 0, falseStarts: 0 });
  });

  it('handles punctuation and case', () => {
    expect(analyzeStutterText('No, no, I said STOP!')).toEqual({ repetitions: 1, falseStarts: 0 });
  });
});

describe('choppiness', () => {
  const burst = (startMs: number, lengthMs: number) => ({ startMs, endMs: startMs + lengthMs });

  it('is 0 with too few bursts to judge', () => {
    expect(choppiness([])).toBe(0);
    expect(choppiness([burst(0, 100), burst(200, 100)])).toBe(0);
  });

  it('is the short-burst fraction with enough bursts', () => {
    expect(choppiness([burst(0, 150), burst(300, 150), burst(600, 150)])).toBe(1);
    expect(
      choppiness([burst(0, 150), burst(300, 150), burst(600, 800), burst(1500, 900)]),
    ).toBe(0.5);
  });
});

describe('analyzeStutter', () => {
  it('combines text and audio features', () => {
    const result = analyzeStutter('I I wa- want that', []);
    expect(result).toEqual({
      detected: true,
      repetitions: 1,
      falseStarts: 1,
      choppiness: 0,
    });
  });

  it('detects on choppiness alone', () => {
    const bursts = [0, 300, 600, 900].map((s) => ({ startMs: s, endMs: s + 150 }));
    const result = analyzeStutter('please stop calling me now', bursts);
    expect(result.detected).toBe(true);
    expect(result.choppiness).toBe(1);
  });
});
