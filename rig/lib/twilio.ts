const sid = (): string => process.env.TWILIO_ACCOUNT_SID!;
const auth = (): string =>
  'Basic ' + Buffer.from(`${process.env.TWILIO_API_KEY_SID}:${process.env.TWILIO_API_KEY_SECRET}`).toString('base64');

async function twilio(method: string, path: string, form?: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid()}${path}`, {
    method,
    headers: { authorization: auth(), 'content-type': 'application/x-www-form-urlencoded' },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`twilio ${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

export async function createCall(opts: { to: string; from: string; twiml: string; timeLimitSec?: number }): Promise<string> {
  const call = await twilio('POST', '/Calls.json', {
    To: opts.to,
    From: opts.from,
    Twiml: opts.twiml,
    TimeLimit: String(opts.timeLimitSec ?? 150),
  });
  return String(call.sid);
}

export async function endCall(callSid: string): Promise<void> {
  try {
    await twilio('POST', `/Calls/${callSid}.json`, { Status: 'completed' });
  } catch {
    // already over
  }
}

export async function setVoiceUrl(numberSid: string, url: string): Promise<void> {
  await twilio('POST', `/IncomingPhoneNumbers/${numberSid}.json`, { VoiceUrl: url, VoiceMethod: 'POST' });
}
