import WebSocket from 'ws';

/** The JSON event channel to a realtime speech model: the only seam the agent needs. */
export interface RealtimeSocket {
  send(event: Record<string, unknown>): void;
  close(): void;
  onOpen(handler: () => void): void;
  onEvent(handler: (event: Record<string, unknown>) => void): void;
  /** The connection ended or failed; fired at most once. */
  onClosed(handler: (reason: string) => void): void;
}

export type RealtimeSocketFactory = (model: string) => RealtimeSocket;

/** OpenAI Realtime API over WebSocket (GA shape). */
export function openAiRealtimeSocketFactory(apiKey: string): RealtimeSocketFactory {
  return (model) => {
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    let closedHandler: ((reason: string) => void) | null = null;
    let closed = false;
    const fireClosed = (reason: string): void => {
      if (closed) return;
      closed = true;
      closedHandler?.(reason);
    };
    ws.on('error', (err: Error) => fireClosed(err.message));
    ws.on('close', (code: number) => fireClosed(`socket closed (${code})`));
    return {
      send(event) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
      },
      close() {
        closed = true;
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      },
      onOpen(handler) {
        ws.on('open', handler);
      },
      onEvent(handler) {
        ws.on('message', (data: Buffer | string) => {
          try {
            handler(JSON.parse(data.toString()) as Record<string, unknown>);
          } catch {
            /* not JSON: ignore */
          }
        });
      },
      onClosed(handler) {
        closedHandler = handler;
      },
    };
  };
}
