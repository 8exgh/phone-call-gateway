import { classifyOverlap } from '../../src/realtime/wordSpotter';

describe('classifyOverlap', () => {
  it.each([
    ['Mmm,', 'hum'],
    [' Mm-hmm.', 'hum'],
    ['Uh-huh,', 'hum'],
    ['Aha', 'hum'],
    ['oh', 'hum'],
    ['Hmm.', 'hum'],
    ['Yeah.', 'agreement'],
    ['Okay,', 'agreement'],
    ['Mm-hmm, right.', 'agreement'],
    ['Got it.', 'agreement'],
    ['Oh, I see.', 'agreement'],
    ['Sorry,', 'words'],
    ['Wait', 'words'],
    ['No.', 'words'],
    ['Okay but what about Friday', 'words'],
    ['Yeah, actually', 'words'],
    ['I', 'words'],
    ['Is there', 'words'],
    ['', 'none'],
    [' ', 'none'],
    ['...', 'none'],
  ])('%j -> %s', (text, kind) => {
    expect(classifyOverlap(text)).toBe(kind);
  });
});
