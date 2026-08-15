import twilio from 'twilio';
import { buildStreamTwiml } from './twiml';
import type {
  AvailableNumber,
  CallRecord,
  CreateCallParams,
  CreatedCall,
  PurchasedNumber,
  SendSmsParams,
  SentSms,
  SmsMessage,
  TwilioApi,
} from './twilioApi';

/** Twilio reports prices as negative decimal strings; normalize to +USD. */
function parsePrice(price: string | null | undefined): number | null {
  if (price === null || price === undefined) return null;
  const value = Number.parseFloat(price);
  return Number.isNaN(value) ? null : Math.abs(value);
}

export interface TwilioCredentials {
  accountSid: string;
  /** Classic auth. */
  authToken?: string;
  /** API-key auth (preferred: revocable, doesn't expose the account token). */
  apiKeySid?: string;
  apiKeySecret?: string;
}

export class LiveTwilioApi implements TwilioApi {
  private readonly client: twilio.Twilio;

  constructor(creds: TwilioCredentials) {
    this.client =
      creds.apiKeySid && creds.apiKeySecret
        ? twilio(creds.apiKeySid, creds.apiKeySecret, { accountSid: creds.accountSid })
        : twilio(creds.accountSid, creds.authToken);
  }

  async searchNumbers(areaCode: string): Promise<AvailableNumber[]> {
    // Area codes are unique across the North American Numbering Plan, but
    // Twilio scopes searches by country — so try US first, then Canada
    // (e.g. 587 is Alberta).
    for (const country of ['US', 'CA'] as const) {
      const numbers = await this.client.availablePhoneNumbers(country).local.list({
        areaCode: Number(areaCode),
        voiceEnabled: true,
        limit: 5,
      });
      if (numbers.length > 0) {
        return numbers.map((n) => ({ phoneNumber: n.phoneNumber, locality: n.locality }));
      }
    }
    return [];
  }

  async purchaseNumber(phoneNumber: string): Promise<PurchasedNumber> {
    const purchased = await this.client.incomingPhoneNumbers.create({ phoneNumber });
    return { sid: purchased.sid, phoneNumber: purchased.phoneNumber };
  }

  async listOwnedNumbers(): Promise<PurchasedNumber[]> {
    const numbers = await this.client.incomingPhoneNumbers.list({ limit: 200 });
    return numbers.map((n) => ({ sid: n.sid, phoneNumber: n.phoneNumber }));
  }

  async releaseNumber(sid: string): Promise<void> {
    await this.client.incomingPhoneNumbers(sid).remove();
  }

  async createCall(params: CreateCallParams): Promise<CreatedCall> {
    const call = await this.client.calls.create({
      to: params.to,
      from: params.from,
      twiml: buildStreamTwiml(params.streamUrl),
    });
    return { providerCallSid: call.sid };
  }

  async hangupCall(providerCallSid: string): Promise<void> {
    await this.client.calls(providerCallSid).update({ status: 'completed' });
  }

  async configureVoiceWebhook(sid: string, voiceUrl: string): Promise<void> {
    await this.client.incomingPhoneNumbers(sid).update({ voiceUrl, voiceMethod: 'POST' });
  }

  async sendSms(params: SendSmsParams): Promise<SentSms> {
    const message = await this.client.messages.create({
      to: params.to,
      from: params.from,
      body: params.body,
    });
    return { sid: message.sid, status: message.status };
  }

  async listSms(opts: { sinceDays: number; limit?: number }): Promise<SmsMessage[]> {
    const messages = await this.client.messages.list({
      dateSentAfter: new Date(Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000),
      limit: opts.limit ?? 100,
    });
    return messages.map((m) => ({
      sid: m.sid,
      direction: m.direction === 'inbound' ? 'inbound' : 'outbound',
      from: m.from,
      to: m.to,
      body: m.body,
      status: m.status,
      sentAt: (m.dateSent ?? m.dateCreated).toISOString(),
      priceUsd: parsePrice(m.price),
    }));
  }

  async listCalls(opts: { sinceDays: number; limit?: number }): Promise<CallRecord[]> {
    const calls = await this.client.calls.list({
      startTimeAfter: new Date(Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000),
      limit: opts.limit ?? 500,
    });
    return calls.map((c) => ({
      sid: c.sid,
      direction: c.direction === 'inbound' ? 'inbound' : 'outbound',
      from: c.from,
      to: c.to,
      durationSeconds: Number.parseInt(c.duration ?? '0', 10) || 0,
      priceUsd: parsePrice(c.price),
      startedAt: (c.startTime ?? c.dateCreated).toISOString(),
    }));
  }
}
