import { config as dotenv } from 'dotenv';
import { join } from 'node:path';
import { ElevenLabsVoices } from '../../src/voices/elevenLabsVoices';
import { VoiceCatalog } from '../../src/voices/catalog';

dotenv({ path: join(__dirname, '..', '..', '.env'), override: true });

/** Query the live voice catalog the way GET /voices does: node --import tsx rig/bench/catalog.ts */
async function main(): Promise<void> {
  const catalog = new VoiceCatalog([new ElevenLabsVoices(process.env.ELEVENLABS_API_KEY!)]);
  const filters = [{ accent: 'irish' }, { accent: 'indian', gender: 'female' }, { accent: 'scottish', gender: 'male' }, { accent: 'australian' }, { search: 'calm', gender: 'female', accent: 'british' }];
  for (const filter of filters) {
    const list = await catalog.listAll(filter);
    console.log(JSON.stringify(filter), '->', list.length, 'voices; first 4:');
    for (const v of list.slice(0, 4)) console.log('   ', v.id.padEnd(33), v.name.slice(0, 22).padEnd(22), v.gender.padEnd(7), v.accent.padEnd(11), v.age.padEnd(12), v.description.slice(0, 48));
  }
  const all = await catalog.listAll();
  console.log('unfiltered:', all.length, 'voices; filter values', JSON.stringify(catalog.facets(all)));
  console.log('notes', JSON.stringify(catalog.notes()));
}
void main();
