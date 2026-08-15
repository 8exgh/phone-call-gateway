import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { EventStore } from './eventStore';

/**
 * Client registry as a projection over the event log (CQRS+ES): commands
 * append client.* events, queries read the in-memory projection rebuilt by
 * replay at boot. The pre-ES clients.json (if present) is imported into the
 * log once and renamed aside.
 */

export interface InboundPolicy {
  goal: string;
  openingLine?: string;
  voice?: string;
}

export interface ClientLimits {
  maxNumbers: number;
  maxCallHoursPerMonth: number;
}

export interface ClientRecord {
  id: string;
  name: string;
  apiKey: string;
  createdAt: string;
  phoneNumber?: string;
  numberSid?: string;
  inbound?: InboundPolicy | null;
  limits: ClientLimits;
}

const DEFAULT_LIMITS: ClientLimits = { maxNumbers: 1, maxCallHoursPerMonth: 90 };

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'client';
  return `${base}-${randomBytes(2).toString('hex')}`;
}

export class ClientStore {
  private clients = new Map<string, ClientRecord>();
  private loaded = false;

  constructor(
    private readonly events: EventStore,
    /** Directory that may hold a legacy clients.json to import. */
    private readonly legacyDir?: string,
  ) {}

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.importLegacyJson();
    for (const event of this.events.readAll('client.')) this.apply(event.type, event.data);
  }

  private importLegacyJson(): void {
    if (!this.legacyDir) return;
    const file = path.join(this.legacyDir, 'clients.json');
    if (!existsSync(file) || this.events.readAll('client.').length > 0) return;
    const records = JSON.parse(readFileSync(file, 'utf8')) as ClientRecord[];
    for (const record of records) {
      this.events.append(`client:${record.id}`, 'client.created', { ...record });
    }
    renameSync(file, `${file}.imported`);
  }

  private apply(type: string, data: Record<string, unknown>): void {
    switch (type) {
      case 'client.created': {
        const record = data as unknown as ClientRecord;
        this.clients.set(record.id, { ...record });
        break;
      }
      case 'client.updated': {
        const { id, patch } = data as { id: string; patch: Record<string, unknown> };
        const record = this.clients.get(id);
        if (!record) return;
        for (const [key, value] of Object.entries(patch)) {
          if (value === null && (key === 'phoneNumber' || key === 'numberSid')) {
            delete (record as unknown as Record<string, unknown>)[key];
          } else {
            (record as unknown as Record<string, unknown>)[key] = value;
          }
        }
        break;
      }
      case 'client.removed': {
        this.clients.delete((data as { id: string }).id);
        break;
      }
      default:
        break;
    }
  }

  private appendAndApply(stream: string, type: string, data: Record<string, unknown>): void {
    this.events.append(stream, type, data);
    this.apply(type, data);
  }

  create(name: string, phoneNumber?: string): ClientRecord {
    this.ensureLoaded();
    if (phoneNumber && this.findByNumber(phoneNumber)) {
      throw new Error(`number ${phoneNumber} is already bound to another client`);
    }
    const record: ClientRecord = {
      id: slugify(name),
      name,
      apiKey: `pgw_${randomBytes(16).toString('hex')}`,
      createdAt: new Date().toISOString(),
      ...(phoneNumber ? { phoneNumber } : {}),
      inbound: null,
      limits: { ...DEFAULT_LIMITS },
    };
    this.appendAndApply(`client:${record.id}`, 'client.created', { ...record });
    return record;
  }

  list(): ClientRecord[] {
    this.ensureLoaded();
    return [...this.clients.values()];
  }

  get(id: string): ClientRecord | undefined {
    this.ensureLoaded();
    return this.clients.get(id);
  }

  findByApiKey(apiKey: string): ClientRecord | undefined {
    this.ensureLoaded();
    return [...this.clients.values()].find((c) => c.apiKey === apiKey);
  }

  findByNumber(phoneNumber: string): ClientRecord | undefined {
    this.ensureLoaded();
    return [...this.clients.values()].find((c) => c.phoneNumber === phoneNumber);
  }

  update(id: string, patch: Partial<Omit<ClientRecord, 'id' | 'apiKey' | 'createdAt'>>): ClientRecord {
    this.ensureLoaded();
    if (!this.clients.has(id)) throw new Error(`no client ${id}`);
    // JSON has no undefined: unset fields travel as explicit nulls.
    const normalized = Object.fromEntries(
      Object.entries(patch).map(([k, v]) => [k, v === undefined ? null : v]),
    );
    this.appendAndApply(`client:${id}`, 'client.updated', { id, patch: normalized });
    return this.clients.get(id)!;
  }

  remove(id: string): boolean {
    this.ensureLoaded();
    if (!this.clients.has(id)) return false;
    this.appendAndApply(`client:${id}`, 'client.removed', { id });
    return true;
  }
}
