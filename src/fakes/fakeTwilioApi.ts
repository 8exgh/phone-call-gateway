import type {
  AvailableNumber,
  CreateCallParams,
  CreatedCall,
  PurchasedNumber,
  TwilioApi,
} from '../telephony/twilioApi';
import { FakeTwilioMediaClient } from './fakeTwilioMediaClient';
import { defaultCallerScript, type CallerScript } from './callerScript';

export interface FakeTwilioApiOptions {
  /** Caller behavior for calls created through this API (default: a demo conversation). */
  script?: CallerScript;
  /** Real-time ms between media frames; 0 (default) runs faster than realtime. */
  framePacingMs?: number;
  /** Delay before the fake callee "answers" (media stream connects). */
  answerDelayMs?: number;
}

/**
 * In-process Twilio. Number provisioning is bookkeeping; createCall spawns a
 * FakeTwilioMediaClient that connects to the gateway's media WebSocket exactly
 * as Twilio would.
 */
export class FakeTwilioApi implements TwilioApi {
  readonly purchasedNumbers: PurchasedNumber[] = [];
  readonly mediaClients: FakeTwilioMediaClient[] = [];
  private readonly clientsBySid = new Map<string, FakeTwilioMediaClient>();
  private counter = 0;

  constructor(private readonly opts: FakeTwilioApiOptions = {}) {}

  async searchNumbers(areaCode: string): Promise<AvailableNumber[]> {
    return [0, 1, 2].map((n) => ({
      phoneNumber: `+1${areaCode}555010${n}`,
      locality: 'Mockville',
    }));
  }

  async purchaseNumber(phoneNumber: string): Promise<PurchasedNumber> {
    const purchased = { sid: `PN-fake-${++this.counter}`, phoneNumber };
    this.purchasedNumbers.push(purchased);
    return purchased;
  }

  async listOwnedNumbers(): Promise<PurchasedNumber[]> {
    return [...this.purchasedNumbers];
  }

  async releaseNumber(sid: string): Promise<void> {
    const index = this.purchasedNumbers.findIndex((p) => p.sid === sid);
    if (index === -1) throw new Error(`no owned number with sid ${sid}`);
    this.purchasedNumbers.splice(index, 1);
  }

  async createCall(params: CreateCallParams): Promise<CreatedCall> {
    if (!this.purchasedNumbers.some((p) => p.phoneNumber === params.from)) {
      throw new Error(`from number ${params.from} is not owned by this account`);
    }
    const id = ++this.counter;
    const providerCallSid = `CA-fake-${id}`;
    const client = new FakeTwilioMediaClient({
      url: params.streamUrl,
      providerCallSid,
      streamSid: `MZ-fake-${id}`,
      script: this.opts.script ?? defaultCallerScript,
      framePacingMs: this.opts.framePacingMs ?? 0,
    });
    this.mediaClients.push(client);
    this.clientsBySid.set(providerCallSid, client);
    return { providerCallSid };
  }

  async hangupCall(providerCallSid: string): Promise<void> {
    this.clientsBySid.get(providerCallSid)?.endCall();
  }
}
