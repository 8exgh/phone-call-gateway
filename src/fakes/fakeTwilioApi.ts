import type {
  AvailableNumber,
  CreateCallParams,
  CreatedCall,
  PurchasedNumber,
  SendSmsParams,
  SentSms,
  SmsMessage,
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

  readonly smsMessages: SmsMessage[] = [];

  async sendSms(params: SendSmsParams): Promise<SentSms> {
    if (!this.purchasedNumbers.some((p) => p.phoneNumber === params.from)) {
      throw new Error(`from number ${params.from} is not owned by this account`);
    }
    const message: SmsMessage = {
      sid: `SM-fake-${++this.counter}`,
      direction: 'outbound',
      from: params.from,
      to: params.to,
      body: params.body,
      status: 'delivered',
      sentAt: new Date().toISOString(),
    };
    this.smsMessages.unshift(message);
    return { sid: message.sid, status: 'queued' };
  }

  /** Test/mock helper: simulate an SMS arriving at one of our numbers. */
  receiveSms(opts: { from: string; to?: string; body: string; sentAt?: string }): SmsMessage {
    const message: SmsMessage = {
      sid: `SM-fake-${++this.counter}`,
      direction: 'inbound',
      from: opts.from,
      to: opts.to ?? this.purchasedNumbers[0]?.phoneNumber ?? '+15550000000',
      body: opts.body,
      status: 'received',
      sentAt: opts.sentAt ?? new Date().toISOString(),
    };
    this.smsMessages.unshift(message);
    return message;
  }

  async listSms(opts: { sinceDays: number; limit?: number }): Promise<SmsMessage[]> {
    const cutoff = Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000;
    return this.smsMessages
      .filter((m) => Date.parse(m.sentAt) >= cutoff)
      .slice(0, opts.limit ?? 100);
  }
}
