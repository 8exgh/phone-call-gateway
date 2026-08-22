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

/** One webhook delivery attempt (a ping to the owning client's notify URL). */
export interface NotificationAttempt {
  /** Ping kind, e.g. followup.promised. */
  event: string;
  /** Stable id (= idempotency key) shared by every attempt of the same ping. */
  notificationId: string;
  /** 1-based attempt counter within one ping (retries count up). */
  attempt: number;
  at: string;
  url: string;
  ok: boolean;
  status?: number;
  /** Why it failed: HTTP status text or the fetch error (e.g. ECONNREFUSED). */
  error?: string;
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
  /**
   * True once the owning client's endpoint accepted (2xx) the followup.promised
   * ping. Until then the promise has reached nobody and the gateway keeps
   * re-delivering it.
   */
  followUpDelivered: boolean;
  /** Every webhook delivery attempt for this call, oldest first (diagnosis). */
  notifications: NotificationAttempt[];
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
/** Delivery attempts kept per record (a dead endpoint re-pinged for days would otherwise grow it). */
const MAX_NOTIFICATIONS = 40;

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
          followUpDelivered: false,
          notifications: [],
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
      case 'orchestration.notified': {
        const { id, ...attempt } = data as unknown as { id: string } & NotificationAttempt;
        const record = this.records.get(id);
        if (!record) return;
        record.notifications.push(attempt);
        if (record.notifications.length > MAX_NOTIFICATIONS) {
          record.notifications.splice(0, record.notifications.length - MAX_NOTIFICATIONS);
        }
        if (attempt.ok && attempt.event === 'followup.promised') record.followUpDelivered = true;
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

  /** Record one webhook delivery attempt; returns the stored entry. */
  notified(id: string, attempt: Omit<NotificationAttempt, 'at'>): NotificationAttempt {
    this.ensureLoaded();
    const stored: NotificationAttempt = { ...attempt, at: new Date().toISOString() };
    this.appendAndApply(id, 'orchestration.notified', { id, ...stored });
    return stored;
  }

  /**
   * Finished calls that still owe a callback nobody has been told about:
   * followUpRequired, the followup.promised ping never accepted, started on or
   * after `sinceIso`. These get re-pinged until a receiver answers 2xx.
   */
  owedFollowUps(sinceIso: string): OrchestrationRecord[] {
    this.ensureLoaded();
    return [...this.records.values()].filter(
      (r) =>
        r.status !== 'running' &&
        r.followUpRequired &&
        !r.followUpDelivered &&
        r.startedAt >= sinceIso,
    );
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
