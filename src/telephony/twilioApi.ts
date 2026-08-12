/**
 * Seam between the gateway and Twilio. LiveTwilioApi wraps the Twilio SDK;
 * FakeTwilioApi implements the same surface in-process for mock mode and tests.
 */

export interface AvailableNumber {
  phoneNumber: string;
  locality?: string;
}

export interface PurchasedNumber {
  sid: string;
  phoneNumber: string;
}

export interface CreateCallParams {
  to: string;
  from: string;
  /** wss:// (or ws:// in mock mode) URL of this gateway's media-stream endpoint. */
  streamUrl: string;
}

export interface CreatedCall {
  providerCallSid: string;
}

export interface TwilioApi {
  searchNumbers(areaCode: string): Promise<AvailableNumber[]>;
  purchaseNumber(phoneNumber: string): Promise<PurchasedNumber>;
  createCall(params: CreateCallParams): Promise<CreatedCall>;
  hangupCall(providerCallSid: string): Promise<void>;
}
