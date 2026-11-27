import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeCall, renderScorecard, scorecard, type CallMetrics } from './analyze';
import { readWavStereo } from './lib/audio';
import { SCENARIOS } from './scenarios';

/**
 * Re-grade a saved run with the current analysis (same recordings, same
 * gateway timelines), keeping any listener ratings it already has.
 *
 *   node --import tsx rig/rescore.ts rig/out/<run> [more runs...]
 */
for (const dir of process.argv.slice(2)) {
  const calls: CallMetrics[] = [];
  for (const file of readdirSync(dir).filter((f) => /-\d+\.json$/.test(f)).sort()) {
    const saved = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
      segments: Parameters<typeof analyzeCall>[0]['segments'];
      metrics: CallMetrics;
      gateway: Parameters<typeof analyzeCall>[0]['gateway'];
    };
    const { right } = readWavStereo(join(dir, file.replace(/\.json$/, '.wav')));
    const scenario = SCENARIOS.find((s) => s.name === saved.metrics.scenario);
    calls.push(
      analyzeCall({
        scenario: saved.metrics.scenario,
        agent: right,
        segments: saved.segments,
        durationMs: saved.metrics.durationMs,
        endedBy: saved.metrics.endedBy,
        notes: saved.metrics.notes,
        success: scenario?.success,
        gateway: saved.gateway,
      }),
    );
  }
  const judge = existsSync(join(dir, 'judge.json'))
    ? (JSON.parse(readFileSync(join(dir, 'judge.json'), 'utf8')) as { naturalness: number | null; intelligibility: number | null })
    : null;
  const text = renderScorecard(scorecard(calls, judge ? { naturalness: judge.naturalness, intelligibility: judge.intelligibility } : {}), `Scorecard: ${dir.split('/').pop()}`);
  writeFileSync(join(dir, 'scorecard.md'), text);
  console.log(text);
}
