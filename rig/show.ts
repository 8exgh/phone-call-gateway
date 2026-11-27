import { readFileSync } from 'node:fs';

/** Print one recorded call as a readable timeline: node --import tsx rig/show.ts <call.json> */
const d = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const rows: [number, string][] = [];
for (const l of d.metrics.lines) {
  const extra = [
    l.replyGapMs !== undefined ? `reply gap ${l.replyGapMs}ms` : '',
    l.collision ?? '',
    l.noReply ? 'NO REPLY' : '',
    l.cutOff ? 'CUT OFF' : '',
    l.stopMs !== undefined ? `agent stopped after ${l.stopMs}ms${l.ignored ? ' (IGNORED)' : ''}` : '',
    l.skipped ? 'skipped (agent was not talking)' : '',
  ].filter(Boolean).join(', ');
  rows.push([l.startMs, `CALLER ${l.startMs}-${l.endMs} [${l.expect}] "${l.text}"${extra ? `  => ${extra}` : ''}`]);
}
for (const s of d.metrics.agentSegments) rows.push([s.startMs, `  agent ${s.startMs}-${s.endMs} (${s.endMs - s.startMs}ms)`]);
rows.sort((a, b) => a[0] - b[0]);
for (const [, text] of rows) console.log(text);
console.log(`stalls: ${JSON.stringify(d.metrics.stalls)}  clears: ${d.metrics.gatewayClears}  task: ${d.metrics.taskDone}  ended by: ${d.metrics.endedBy}`);
if (process.argv[3] === 'gw') {
  console.log('--- gateway');
  for (const t of d.gateway?.turns ?? []) console.log(`  ${t.role}: ${t.text}`);
  console.log((d.gateway?.events ?? []).join('\n'));
}
