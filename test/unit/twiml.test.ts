import { buildStreamTwiml } from '../../src/telephony/twiml';

describe('buildStreamTwiml', () => {
  it('produces bidirectional Connect/Stream TwiML', () => {
    expect(buildStreamTwiml('wss://example.ngrok.app/twilio/media/c1')).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Response><Connect><Stream url="wss://example.ngrok.app/twilio/media/c1" /></Connect></Response>',
    );
  });

  it('escapes XML special characters in the URL', () => {
    const twiml = buildStreamTwiml('wss://h/x?a=1&b="2"<3>');
    expect(twiml).toContain('url="wss://h/x?a=1&amp;b=&quot;2&quot;&lt;3&gt;"');
  });
});
