import { getClip } from '../lib/clips';
import { rms } from '../lib/audio';

/** Loudness and "hum vs word" character of caller clips: can a listening noise be told from an interruption early? */
async function main(): Promise<void> {
  const clips = ['Mm-hmm.', 'Uh-huh.', 'Sorry, sorry, actually, I just need the address.', 'Wait, hang on, just the exam price please.', 'Is there parking?', 'Sarah Mitchell.', 'Great, thanks. Bye.', 'What time do you close on Saturday?'];
  for (const text of clips) {
    const clip = await getClip(text, 'hesitant');
    const levels: number[] = [];
    const zcrs: number[] = [];
    for (let i = 0; i + 160 <= clip.length && levels.length < 30; i += 160) {
      const level = rms(clip, i, i + 160);
      if (level < 220 && levels.length === 0) continue;
      levels.push(Math.round(level));
      let z = 0;
      for (let j = i + 1; j < i + 160; j++) if ((clip[j]! >= 0) !== (clip[j - 1]! >= 0)) z++;
      zcrs.push(z);
    }
    const loud = levels.filter((l) => l > 220);
    const mean = Math.round(loud.reduce((a, b) => a + b, 0) / Math.max(1, loud.length));
    console.log(`${text.slice(0, 34).padEnd(34)} mean=${String(mean).padStart(5)} first600ms rms=[${levels.slice(0, 15).join(',')}] zcr=[${zcrs.slice(0, 15).join(',')}]`);
  }
}
void main();
