import type { WebSocket } from 'ws';
import { parseClientMessage, type ServerMessage } from '../protocol/messages';
import type { CallSession } from './callSession';

/**
 * Handles one control WebSocket connection: the orchestrator-facing API.
 * One control client per call; a second connection is rejected.
 */
export function handleControlConnection(ws: WebSocket, session: CallSession | undefined): void {
  const sendRaw = (msg: ServerMessage): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  if (!session) {
    sendRaw({ type: 'error', code: 'unknown_call', message: 'no such call' });
    ws.close();
    return;
  }

  if (!session.attachControl(sendRaw)) {
    sendRaw({ type: 'error', code: 'control_busy', message: 'a control client is already attached' });
    ws.close();
    return;
  }

  ws.on('message', (data: Buffer | string) => {
    const result = parseClientMessage(data.toString());
    if (!result.ok) {
      sendRaw({ type: 'error', code: 'invalid_message', message: result.error });
      return;
    }
    session.handleControlMessage(result.message);
  });

  ws.on('close', () => session.detachControl());
  ws.on('error', () => {
    // close follows; detach happens there.
  });
}
