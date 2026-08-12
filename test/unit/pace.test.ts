import { countWords, computeWpm, classifyWpm } from '../../src/prosody/pace';

describe('pace', () => {
  it('counts words, ignoring bare punctuation', () => {
    expect(countWords('I want to cancel my order')).toBe(6);
    expect(countWords('  hello,   world!  ')).toBe(2);
    expect(countWords('wa- want')).toBe(2);
    expect(countWords('')).toBe(0);
    expect(countWords(' - ')).toBe(0);
  });

  it('computes words per minute from voiced time', () => {
    expect(computeWpm(6, 2000)).toBe(180);
    expect(computeWpm(4, 4000)).toBe(60);
    expect(computeWpm(10, 60000)).toBe(10);
  });

  it('guards segments with too little voiced audio', () => {
    expect(computeWpm(3, 400)).toBeNull();
    expect(computeWpm(0, 2000)).toBeNull();
  });

  it('classifies WPM bands', () => {
    expect(classifyWpm(null)).toBe('normal');
    expect(classifyWpm(60)).toBe('calm');
    expect(classifyWpm(84)).toBe('calm');
    expect(classifyWpm(85)).toBe('slow');
    expect(classifyWpm(114)).toBe('slow');
    expect(classifyWpm(115)).toBe('normal');
    expect(classifyWpm(164)).toBe('normal');
    expect(classifyWpm(165)).toBe('fast');
    expect(classifyWpm(220)).toBe('fast');
  });
});
