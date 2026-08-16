import type { ConversationTurn } from '../orchestrator/orchestrator';
import type { EventStore } from './eventStore';

/**
 * Orchestration history as a projection over the event log: started /
 * transcript-line / errored / finished events append as calls progress, and
 * the projection (which serves all polling reads) is rebuilt by replay at
 * boot — so call history now survives restarts.
 */

export interface ToolRequestRecord {
  id: string;
  name: string;
  /** Raw JSON argument string as the voice model produced it. */
  arguments: string;
  status: 'open' | 'answered' | 'callback_promised';
  requestedAt: string;
  answeredAt?: string;
  result?: string;
}

export interface OrchestrationRecord {
  id: string;
  direction: 'inbound' | 'outbound';
  startedAt: string;
  /** Owning client, when the call belongs to a registered client. */
  clientId?: string;
  to: string;
  from: string;
  goal: string;
  status: 'running' | 'ended' | 'failed';
  reason?: string;
  /** Mid-call tool invocations awaiting (or given) external fulfillment. */
  pendingRequests: ToolRequestRecord[];
  /** True when the agent promised a callback: run the tools, respond, call back. */
  followUpRequired: boolean;
  /** Full conversation once the call finishes. */
  turns: ConversationTurn[];
  /** Caller transcript lines observed so far, with prosody, for live polling. */
  liveTranscript: string[];
  /** In-call error events (e.g. stt_failed), so failures are visible when polling. */
  errors: string[];
  /** Compact timeline of every control event, for post-call diagnosis. */
  events: string[];
}

/** Projection size cap: the event log keeps everything, RAM keeps the recent. */
const MAX_RECORDS = 500;

export class OrchestrationLog {
  private records = new Map<string, OrchestrationRecord>();
  private loaded = false;

  constructor(private readonly events: EventStore) {}

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    for (const event of this.events.readAll('orchestration.')) this.apply(event.type, event.data);
    // Calls that were mid-flight when the process died can never finish.
    for (const record of this.records.values()) {
      if (record.status === 'running') {
        record.status = 'failed';
        record.reason = 'interrupted by gateway restart';
      }
    }
    this.evict();
  }

  private evict(): void {
    while (this.records.size > MAX_RECORDS) {
      const oldest = [...this.records.values()].sort((a, b) =>
        a.startedAt.localeCompare(b.startedAt),
      )[0]!;
      this.records.delete(oldest.id);
    }
  }

  private apply(type: string, data: Record<string, unknown>): void {
    switch (type) {
      case 'orchestration.started': {
        const base = data as unknown as Omit<
          OrchestrationRecord,
          'turns' | 'liveTranscript' | 'errors' | 'events'
        >;
        this.records.set(base.id, {
          ...base,
          status: 'running',
          pendingRequests: [],
          followUpRequired: false,
          turns: [],
          liveTranscript: [],
          errors: [],
          events: [],
        });
        this.evict();
        break;
      }
      case 'orchestration.line': {
        const { id, line } = data as { id: string; line: string };
        this.records.get(id)?.liveTranscript.push(line);
        break;
      }
      case 'orchestration.errored': {
        const { id, error } = data as { id: string; error: string };
        this.records.get(id)?.errors.push(error);
        break;
      }
      case 'orchestration.tool_requested': {
        const { id, request } = data as { id: string; request: Omit<ToolRequestRecord, 'status'> };
        this.records.get(id)?.pendingRequests.push({ ...request, status: 'open' });
        break;
      }
      case 'orchestration.tool_answered': {
        const { id, requestId, result } = data as { id: string; requestId: string; result: string };
        const record = this.records.get(id);
        const request = record?.pendingRequests.find((r) => r.id === requestId);
        if (!record || !request) return;
        request.status = 'answered';
        request.result = result;
        request.answeredAt = new Date().toISOString();
        record.followUpRequired = record.pendingRequests.some(
          (r) => r.status === 'callback_promised',
        );
        break;
      }
      case 'orchestration.followup_promised': {
        const { id, requestIds } = data as { id: string; requestIds: string[] };
        const record = this.records.get(id);
        if (!record) return;
        for (const r of record.pendingRequests) {
          if (requestIds.includes(r.id) && r.status === 'open') r.status = 'callback_promised';
        }
        record.followUpRequired = true;
        break;
      }
      case 'orchestration.finished': {
        const { id, status, reason, turns, timeline } = data as {
          id: string;
          status: 'ended' | 'failed';
          reason?: string;
          turns: ConversationTurn[];
          timeline: string[];
        };
        const record = this.records.get(id);
        if (!record) return;
        record.status = status;
        record.reason = reason;
        record.turns = turns;
        record.events = timeline;
        break;
      }
      default:
        break;
    }
  }

  private appendAndApply(id: string, type: string, data: Record<string, unknown>): void {
    this.events.append(`orchestration:${id}`, type, data);
    this.apply(type, data);
  }

  start(opts: {
    id: string;
    direction: 'inbound' | 'outbound';
    clientId?: string;
    to: string;
    from: string;
    goal: string;
  }): OrchestrationRecord {
    this.ensureLoaded();
    this.appendAndApply(opts.id, 'orchestration.started', {
      ...opts,
      startedAt: new Date().toISOString(),
    });
    return this.records.get(opts.id)!;
  }

  line(id: string, line: string): void {
    this.ensureLoaded();
    this.appendAndApply(id, 'orchestration.line', { id, line });
  }

  error(id: string, error: string): void {
    this.ensureLoaded();
    this.appendAndApply(id, 'orchestration.errored', { id, error });
  }

  toolRequested(id: string, request: { id: string; name: string; arguments: string }): void {
    this.ensureLoaded();
    this.appendAndApply(id, 'orchestration.tool_requested', {
      id,
      request: { ...request, requestedAt: new Date().toISOString() },
    });
  }

  toolAnswered(id: string, requestId: string, result: string): void {
    this.ensureLoaded();
    this.appendAndApply(id, 'orchestration.tool_answered', {
      id,
      requestId,
      result: result.slice(0, 4000),
    });
  }

  followUpPromised(id: string, requestIds: string[]): void {
    this.ensureLoaded();
    this.appendAndApply(id, 'orchestration.followup_promised', { id, requestIds });
  }

  finish(
    id: string,
    result: { status: 'ended' | 'failed'; reason?: string; turns: ConversationTurn[]; timeline: string[] },
  ): void {
    this.ensureLoaded();
    this.appendAndApply(id, 'orchestration.finished', { id, ...result });
  }

  get(id: string): OrchestrationRecord | undefined {
    this.ensureLoaded();
    return this.records.get(id);
  }

  list(): OrchestrationRecord[] {
    this.ensureLoaded();
    return [...this.records.values()];
  }
}
