import 'dotenv/config';
import { loadConfig, type AppConfig } from './config';
import { buildServer, type ServerDeps } from './server';
import { FakeTwilioApi } from './fakes/fakeTwilioApi';
import { FakeSpeechSynthesizer } from './fakes/fakeSynthesizer';
import { FakeTranscriberFactory } from './fakes/fakeTranscriber';
import { defaultCallerScript } from './fakes/callerScript';
import { FakeChatClient, demoChatScript } from './fakes/fakeChatClient';
import { LiveTwilioApi } from './telephony/liveTwilioApi';
import { OpenAiSpeechSynthesizer } from './speech/openAiSynthesizer';
import { OpenAiTranscriberFactory } from './speech/openAiTranscriber';
import { OpenAiChatClient } from './orchestrator/openAiChatClient';

export function buildDeps(config: AppConfig, opts: { framePacingMs?: number } = {}): ServerDeps {
  if (config.mode === 'live') {
    // loadConfig guarantees these are present in live mode.
    return {
      twilioApi: new LiveTwilioApi({
        accountSid: config.twilioAccountSid!,
        authToken: config.twilioAuthToken,
        apiKeySid: config.twilioApiKeySid,
        apiKeySecret: config.twilioApiKeySecret,
      }),
      synthesizer: new OpenAiSpeechSynthesizer(config.openAiApiKey!, config.ttsModel, config.ttsVoice),
      transcriberFactory: new OpenAiTranscriberFactory(
        config.openAiApiKey!,
        config.transcribeModel,
        config.transcribeLanguage,
      ),
      chatClientFactory: () => new OpenAiChatClient(config.openAiApiKey!, config.chatModel),
    };
  }
  return {
    // Realtime frame pacing by default so a mock demo behaves like a real call.
    twilioApi: new FakeTwilioApi({
      script: defaultCallerScript,
      framePacingMs: opts.framePacingMs ?? 20,
    }),
    synthesizer: new FakeSpeechSynthesizer(),
    transcriberFactory: new FakeTranscriberFactory(defaultCallerScript),
    chatClientFactory: () =>
      config.openAiApiKey
        ? new OpenAiChatClient(config.openAiApiKey, config.chatModel)
        : new FakeChatClient(demoChatScript),
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildServer(buildDeps(config), {
    publicWssUrl: config.publicWssUrl,
    ttsVoice: config.ttsVoice,
    twilioFromNumber: config.twilioFromNumber,
  });
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`phone-call-gateway (${config.mode} mode) listening on port ${config.port}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
