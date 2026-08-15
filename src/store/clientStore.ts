import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Multi-tenant client registry. This is the gateway's only durable state:
 * numbers themselves live at Twilio, but WHO owns a number, their API key,
 * their answering persona, and their limits must survive restarts — hence a
 * JSON file on a mounted volume rather than memory.
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
  private clients: ClientRecord[] = [];
  private loaded = false;

  constructor(private readonly dataDir: string) {}

  private get filePath(): string {
    return path.join(this.dataDir, 'clients.json');
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.filePath)) return;
    this.clients = JSON.parse(readFileSync(this.filePath, 'utf8')) as ClientRecord[];
  }

  private save(): void {
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.clients, null, 2));
    renameSync(tmp, this.filePath);
  }

  create(name: string, phoneNumber?: string): ClientRecord {
    this.load();
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
    this.clients.push(record);
    this.save();
    return record;
  }

  list(): ClientRecord[] {
    this.load();
    return [...this.clients];
  }

  get(id: string): ClientRecord | undefined {
    this.load();
    return this.clients.find((c) => c.id === id);
  }

  findByApiKey(apiKey: string): ClientRecord | undefined {
    this.load();
    return this.clients.find((c) => c.apiKey === apiKey);
  }

  findByNumber(phoneNumber: string): ClientRecord | undefined {
    this.load();
    return this.clients.find((c) => c.phoneNumber === phoneNumber);
  }

  update(id: string, patch: Partial<Omit<ClientRecord, 'id' | 'apiKey' | 'createdAt'>>): ClientRecord {
    this.load();
    const record = this.clients.find((c) => c.id === id);
    if (!record) throw new Error(`no client ${id}`);
    Object.assign(record, patch);
    this.save();
    return record;
  }

  remove(id: string): boolean {
    this.load();
    const index = this.clients.findIndex((c) => c.id === id);
    if (index === -1) return false;
    this.clients.splice(index, 1);
    this.save();
    return true;
  }
}
