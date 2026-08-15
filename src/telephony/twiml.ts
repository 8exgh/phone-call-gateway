function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * TwiML for an outbound call that opens a bidirectional media stream to our
 * WebSocket endpoint. <Connect><Stream> (unlike <Start><Stream>) makes the
 * stream bidirectional: we receive caller audio and can write audio back.
 */
export function buildStreamTwiml(wssUrl: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Response><Connect><Stream url="${escapeXmlAttribute(wssUrl)}" /></Connect></Response>`
  );
}

/** Decline an incoming call (used when no inbound answering policy is set). */
export function buildRejectTwiml(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Reject /></Response>';
}
