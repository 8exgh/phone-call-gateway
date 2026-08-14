import { isEchoOfAgent } from '../../src/orchestrator/orchestrator';

describe('isEchoOfAgent (ghost-transcript backstop)', () => {
  const agentTexts = ['Hi Sean! Do I sound clearer than last time?'];

  it('drops transcripts that are mostly a copy of what the agent just said', () => {
    expect(isEchoOfAgent('do I sound clearer', agentTexts)).toBe(true);
    expect(isEchoOfAgent('sound clearer than last time', agentTexts)).toBe(true);
  });

  it('keeps genuine caller speech', () => {
    expect(isEchoOfAgent('yeah you sound way better now', agentTexts)).toBe(false);
    expect(isEchoOfAgent('how is it going', agentTexts)).toBe(false);
  });

  it('keeps short confirmations even when their words appeared in agent speech', () => {
    expect(isEchoOfAgent('last time', agentTexts)).toBe(false);
    expect(isEchoOfAgent('you do', agentTexts)).toBe(false);
  });

  it('drops empty or punctuation-only transcripts', () => {
    expect(isEchoOfAgent('...', agentTexts)).toBe(true);
  });

  it('keeps everything when the agent has not spoken yet', () => {
    expect(isEchoOfAgent('hello anyone there', [])).toBe(false);
  });
});
