import { getClip } from '../lib/clips';
import { rms } from '../lib/audio';
import { SCENARIOS } from '../scenarios';

/** How long are the silences INSIDE each caller clip? (Checks the robot caller talks like a person.) */
async function main(): Promise<void> {
  const seen = new Set<string>();
  const all: number[] = [];
  for (const s of SCENARIOS) {
    for (const step of s.steps) {
      if (!('say' in step) || seen.has(step.say + (step.style ?? s.style ?? ''))) continue;
      seen.add(step.say + (step.style ?? s.style ?? ''));
      const style = step.style ?? s.style ?? 'natural';
      const clip = await getClip(step.say, style);
      const gaps: number[] = [];
      let quiet = 0;
      let loudMs = 0;
      for (let i = 0; i + 160 <= clip.length; i += 160) {
        if (rms(clip, i, i + 160) > 220) {
          if (quiet >= 120) gaps.push(quiet);
          quiet = 0;
          loudMs += 20;
        } else quiet += 20;
      }
      all.push(...gaps);
      console.log(`${String(Math.round(clip.length / 8)).padStart(5)}ms loud=${String(loudMs).padStart(4)} gaps=[${gaps.join(',')}]  (${style}) ${step.say}`);
    }
  }
  all.sort((a, b) => a - b);
  console.log(`inner gaps >=120ms: n=${all.length} median=${all[Math.floor(all.length / 2)]} p90=${all[Math.floor(all.length * 0.9)]} max=${all.at(-1)}`);
}
void main();
