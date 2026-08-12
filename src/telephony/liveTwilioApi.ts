import twilio from 'twilio';
import { buildStreamTwiml } from './twiml';
import type {
  AvailableNumber,
  CreateCallParams,
  CreatedCall,
  PurchasedNumber,
  TwilioApi,
} from './twilioApi';

export class LiveTwilioApi implements TwilioApi {
  private readonly client: twilio.Twilio;

  constructor(accountSid: string, authToken: string) {
    this.client = twilio(accountSid, authToken);
  }

  async searchNumbers(areaCode: string): Promise<AvailableNumber[]> {
    const numbers = await this.client.availablePhoneNumbers('US').local.list({
      areaCode: Number(areaCode),
      voiceEnabled: true,
      limit: 5,
    });
    return numbers.map((n) => ({ phoneNumber: n.phoneNumber, locality: n.locality }));
  }

  async purchaseNumber(phoneNumber: string): Promise<PurchasedNumber> {
    const purchased = await this.client.incomingPhoneNumbers.create({ phoneNumber });
    return { sid: purchased.sid, phoneNumber: purchased.phoneNumber };
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
}
