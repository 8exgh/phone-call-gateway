import type { CallSession } from './callSession';

export class CallRegistry {
  private readonly sessions = new Map<string, CallSession>();

  set(callId: string, session: CallSession): void {
    this.sessions.set(callId, session);
  }

  get(callId: string): CallSession | undefined {
    return this.sessions.get(callId);
  }

  all(): CallSession[] {
    return [...this.sessions.values()];
  }
}
