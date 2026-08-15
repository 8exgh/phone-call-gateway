import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventStore } from '../../src/store/eventStore';

describe('EventStore (append-only SQLite log)', () => {
  it('appends and replays in order', () => {
    const store = new EventStore(':memory:');
    store.append('client:a', 'client.created', { id: 'a' });
    store.append('orchestration:x', 'orchestration.started', { id: 'x' });
    store.append('client:a', 'client.updated', { id: 'a', patch: { phoneNumber: '+1' } });

    const all = store.readAll();
    expect(all.map((e) => e.type)).toEqual([
      'client.created',
      'orchestration.started',
      'client.updated',
    ]);
    expect(all[0]!.id).toBeLessThan(all[2]!.id);
    expect(all[2]!.data).toEqual({ id: 'a', patch: { phoneNumber: '+1' } });
  });

  it('filters replay by type prefix and audit reads by stream', () => {
    const store = new EventStore(':memory:');
    store.append('client:a', 'client.created', { id: 'a' });
    store.append('orchestration:x', 'orchestration.started', { id: 'x' });

    expect(store.readAll('client.').map((e) => e.type)).toEqual(['client.created']);
    expect(store.readRecent(10, 'orchestration:x')).toHaveLength(1);
    expect(store.readRecent(10)[0]!.type).toBe('orchestration.started'); // newest first
  });

  it('persists to disk: a second instance over the same dir sees the log', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pgw-es-'));
    new EventStore(dir).append('client:a', 'client.created', { id: 'a', name: 'jason' });

    const reopened = new EventStore(dir);
    expect(reopened.count()).toBe(1);
    expect(reopened.readAll()[0]!.data).toMatchObject({ name: 'jason' });
  });
});
