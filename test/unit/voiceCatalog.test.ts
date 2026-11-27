import { VoiceCatalog } from '../../src/voices/catalog';

describe('VoiceCatalog', () => {
  const catalog = new VoiceCatalog();

  it('lists every voice with the fields a person needs to choose one', () => {
    const all = catalog.list();
    expect(all.length).toBeGreaterThanOrEqual(10);
    for (const v of all) {
      expect(v.id).toMatch(/^[a-z0-9:_-]+$/i);
      expect(['female', 'male', 'neutral']).toContain(v.gender);
      expect(v.accent.length).toBeGreaterThan(0);
      expect(v.description.length).toBeGreaterThan(0);
      expect(v.previewUrl).toContain(v.id);
    }
  });

  it('filters by gender, accent, and free text, case-insensitively', () => {
    expect(catalog.list({ gender: 'Male' }).every((v) => v.gender === 'male')).toBe(true);
    expect(catalog.list({ gender: 'male' }).length).toBeGreaterThan(0);
    expect(catalog.list({ accent: 'british' }).map((v) => v.id)).toEqual(['ballad']);
    expect(catalog.list({ gender: 'female', accent: 'american' }).length).toBeGreaterThan(1);
    expect(catalog.list({ search: 'calm' }).length).toBeGreaterThan(0);
    expect(catalog.list({ gender: 'robot' })).toEqual([]);
  });

  it('looks a voice up by id regardless of case, and reports the filter values', () => {
    expect(catalog.get('MARIN')?.id).toBe('marin');
    expect(catalog.get('nope')).toBeUndefined();
    expect(catalog.facets().genders).toEqual(['female', 'male', 'neutral']);
    expect(catalog.facets().accents).toContain('British');
  });
});
