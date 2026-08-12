import { loadConfig } from '../../src/config';

const liveBase = {
  MODE: 'live',
  OPENAI_API_KEY: 'sk-test',
  PUBLIC_WSS_URL: 'wss://gw.example.com',
  TWILIO_ACCOUNT_SID: 'ACxxx',
};

describe('loadConfig', () => {
  it('defaults to mock mode with no env', () => {
    const config = loadConfig({});
    expect(config.mode).toBe('mock');
    expect(config.port).toBe(3300);
    expect(config.ttsModel).toBe('gpt-4o-mini-tts');
  });

  it('treats an empty PUBLIC_WSS_URL as unset', () => {
    expect(loadConfig({ PUBLIC_WSS_URL: '' }).publicWssUrl).toBeUndefined();
  });

  it('live mode lists everything missing', () => {
    expect(() => loadConfig({ MODE: 'live' })).toThrow(
      /TWILIO_ACCOUNT_SID.*OPENAI_API_KEY.*PUBLIC_WSS_URL.*TWILIO_AUTH_TOKEN/s,
    );
  });

  it('live mode accepts classic auth-token credentials', () => {
    const config = loadConfig({ ...liveBase, TWILIO_AUTH_TOKEN: 'token' });
    expect(config.mode).toBe('live');
    expect(config.twilioAuthToken).toBe('token');
  });

  it('live mode accepts API-key credentials', () => {
    const config = loadConfig({
      ...liveBase,
      TWILIO_API_KEY_SID: 'SKxxx',
      TWILIO_API_KEY_SECRET: 'secret',
    });
    expect(config.twilioApiKeySid).toBe('SKxxx');
    expect(config.twilioApiKeySecret).toBe('secret');
  });

  it('live mode rejects an API key sid without its secret', () => {
    expect(() => loadConfig({ ...liveBase, TWILIO_API_KEY_SID: 'SKxxx' })).toThrow(
      /TWILIO_AUTH_TOKEN \(or TWILIO_API_KEY_SID \+ TWILIO_API_KEY_SECRET\)/,
    );
  });

  it('live mode still requires the account sid with API-key auth', () => {
    expect(() =>
      loadConfig({
        MODE: 'live',
        OPENAI_API_KEY: 'sk-test',
        PUBLIC_WSS_URL: 'wss://gw.example.com',
        TWILIO_API_KEY_SID: 'SKxxx',
        TWILIO_API_KEY_SECRET: 'secret',
      }),
    ).toThrow(/TWILIO_ACCOUNT_SID/);
  });
});
