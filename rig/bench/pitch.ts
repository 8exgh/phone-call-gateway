import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Median speaking pitch of each voice sample (autocorrelation): an objective check on "sounds male/female". */
const dir = join(__dirname, '..', 'out', 'voices');
for (const file of readdirSync(dir).filter((f) => f.endsWith('.wav')).sort()) {
  const buf = readFileSync(join(dir, file));
  const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.length - ((buf.length - 44) % 2)));
  const f0s: number[] = [];
  const win = 320; // 40ms
  for (let i = 0; i + win * 2 < pcm.length; i += 160) {
    let energy = 0;
    for (let j = 0; j < win; j++) energy += pcm[i + j]! * pcm[i + j]!;
    if (Math.sqrt(energy / win) < 800) continue;
    let best = 0;
    let bestLag = 0;
    for (let lag = 26; lag <= 114; lag++) { // 70..307 Hz at 8kHz
      let num = 0;
      let d1 = 0;
      let d2 = 0;
      for (let j = 0; j < win; j++) {
        const a = pcm[i + j]!;
        const b = pcm[i + j + lag]!;
        num += a * b;
        d1 += a * a;
        d2 += b * b;
      }
      const r = num / Math.sqrt(d1 * d2 + 1);
      if (r > best) {
        best = r;
        bestLag = lag;
      }
    }
    if (best > 0.7) f0s.push(8000 / bestLag);
  }
  f0s.sort((a, b) => a - b);
  const q = (p: number): number => Math.round(f0s[Math.floor(p * f0s.length)] ?? 0);
  console.log(`${file.replace('.wav', '').padEnd(8)} pitch median ${q(0.5)}Hz (25-75%: ${q(0.25)}-${q(0.75)}Hz, ${f0s.length} voiced frames)`);
}
