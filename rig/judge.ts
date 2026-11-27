import { config as dotenv } from 'dotenv';
import { parseArgs } from 'node:util';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI, { toFile } from 'openai';
import { mixMono, readWavStereo, wavMonoBuffer } from './lib/audio';
import { renderScorecard, scorecard, type CallMetrics } from './analyze';

dotenv({ path: join(__dirname, '..', '.env'), override: true });

/**
 * Listen to a run's recordings: an audio model rates each call the way a
 * caller would experience it, and the agent's side is re-transcribed to check
 * its words survived the phone line. Rewrites the run's scorecard with both.
 *
 *   node --import tsx rig/judge.ts --dir rig/out/<run>
 */
const { values } = parseArgs({ options: { dir: { type: 'string' }, model: { type: 'string', default: 'gpt-audio-1.5' } } });
const dir = values.dir!;
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const RUBRIC = `You are an expert evaluator of phone conversations. The attached recording is a phone call between a CALLER (a customer) and an AI receptionist, the AGENT, who answers first. Judge ONLY the AGENT, exactly as the human caller would experience the call.

Score each from 1 (terrible) to 5 (indistinguishable from an excellent human receptionist); decimals allowed:
- responsiveness: does the agent answer promptly, or are there awkward silences before it speaks?
- turn_taking: does it avoid talking over the caller, stop when interrupted, keep going through "mm-hmm", and never jump in while the caller is mid-thought?
- voice: does the speech sound natural and clear (intonation, pacing, no glitches, dropouts or robotic artifacts)?
- phrasing: is the wording conversational and concise, without robotic repetition or re-asking?
- overall: your overall impression of how natural and pleasant this was.

Measured facts about this call (trust these timings over your own sense of time):
{{FACTS}}

Reply with ONLY a JSON object: {"responsiveness":n,"turn_taking":n,"voice":n,"phrasing":n,"overall":n,"worst_moments":["..."],"summary":"one sentence"}`;

const NUMBERISH = new Set(
  'dollar dollars pm am zero oh one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand and'.split(' '),
);

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z\s']/g, ' ')
    .split(/\s+/)
    // Numbers, money and times are written many ways ("$189", "one hundred eighty-nine
    // dollars", "1 p.m."): comparing their spelling is not a hearing test.
    .filter((w) => w.length > 1 && !NUMBERISH.has(w));

function facts(m: CallMetrics): string {
  const out: string[] = [];
  for (const l of m.lines) {
    const what =
      l.replyGapMs !== undefined ? `agent started answering ${l.replyGapMs}ms after the caller finished`
      : l.collision ? `agent and caller spoke at the same time (${l.collision})`
      : l.noReply ? 'agent never answered'
      : l.cutOff ? 'agent started talking during the caller\'s mid-sentence pause'
      : l.expect === 'hold' ? 'caller paused mid-sentence; agent correctly waited'
      : '';
    const stop = l.expect === 'bargein' && !l.skipped ? ` caller interrupted the agent; agent ${l.ignored ? 'kept talking through it' : `fell silent after ${l.stopMs}ms`}.` : '';
    const falter = l.hesitationMs !== undefined ? ` The agent's speech paused for ${l.hesitationMs}ms around it${l.hesitationMs > 250 ? ', then carried on' : ' (it kept talking)'}.` : '';
    out.push(`- at ${(l.startMs / 1000).toFixed(1)}s caller said "${l.text}": ${what}.${stop}${falter}`);
  }
  if (m.stalls.length) out.push(`- silences in the middle of agent replies: ${m.stalls.map((s) => `${s}ms`).join(', ')}`);
  if (m.backchannelFalseStops) out.push(`- the agent stopped talking ${m.backchannelFalseStops} time(s) because the caller said "mm-hmm"`);
  return out.join('\n');
}

async function main(): Promise<void> {
  const tags = readdirSync(dir).filter((f) => f.endsWith('.wav')).map((f) => f.slice(0, -4)).sort();
  const results: Record<string, unknown>[] = [];
  const metrics: CallMetrics[] = [];
  let heardWords = 0;
  let intendedWords = 0;
  for (const tag of tags) {
    const meta = JSON.parse(readFileSync(join(dir, `${tag}.json`), 'utf8')) as {
      metrics: CallMetrics;
      gateway: { turns?: { role: string; text: string }[] } | null;
    };
    metrics.push(meta.metrics);
    const { left, right } = readWavStereo(join(dir, `${tag}.wav`));

    // What the caller actually heard the agent say.
    let heard = '';
    try {
      const tr = await client.audio.transcriptions.create({
        model: 'gpt-4o-transcribe',
        file: await toFile(wavMonoBuffer(right), 'agent.wav'),
        language: 'en',
      });
      heard = tr.text;
    } catch (error) {
      heard = `[transcription failed: ${(error as Error).message}]`;
    }
    // Words survive only if the line was clean; skip calls where the gateway cut its own speech.
    const intended = (meta.gateway?.turns ?? []).filter((t) => t.role === 'agent').map((t) => t.text).join(' ');
    let recall: number | null = null;
    if (intended && (meta.metrics.gatewayClears ?? 0) === 0 && !heard.startsWith('[')) {
      const got = new Set(words(heard));
      const want = words(intended);
      const hit = want.filter((w) => got.has(w)).length;
      recall = want.length ? (100 * hit) / want.length : null;
      heardWords += hit;
      intendedWords += want.length;
    }

    let rating: Record<string, unknown> = {};
    try {
      const res = await client.chat.completions.create({
        model: values.model!,
        modalities: ['text'],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: RUBRIC.replace('{{FACTS}}', facts(meta.metrics)) },
              { type: 'input_audio', input_audio: { data: wavMonoBuffer(mixMono(left, right)).toString('base64'), format: 'wav' } },
            ],
          },
        ],
      } as never);
      const text = (res as { choices: { message: { content: string | null } }[] }).choices[0]?.message.content ?? '';
      const json = /\{[\s\S]*\}/.exec(text);
      rating = json ? JSON.parse(json[0]) : { error: text.slice(0, 200) };
    } catch (error) {
      rating = { error: (error as Error).message.slice(0, 300) };
    }
    results.push({ tag, recall, heard, rating });
    console.log(`${tag.padEnd(16)} overall=${rating.overall ?? '?'} resp=${rating.responsiveness ?? '?'} turns=${rating.turn_taking ?? '?'} voice=${rating.voice ?? '?'} phrasing=${rating.phrasing ?? '?'} words=${recall === null ? 'n/a' : recall.toFixed(0) + '%'}${rating.error ? ` ERROR ${rating.error}` : ''}`);
  }

  const overall = results.map((r) => (r.rating as { overall?: number }).overall).filter((v): v is number => typeof v === 'number');
  const naturalness = overall.length ? overall.reduce((a, b) => a + b, 0) / overall.length : null;
  const intelligibility = intendedWords ? (100 * heardWords) / intendedWords : null;
  writeFileSync(join(dir, 'judge.json'), JSON.stringify({ model: values.model, naturalness, intelligibility, results }, null, 2));
  const label = existsSync(join(dir, 'summary.json')) ? (JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as { label: string }).label : dir;
  const text = renderScorecard(scorecard(metrics, { naturalness, intelligibility }), `Scorecard: ${label}`);
  writeFileSync(join(dir, 'scorecard.md'), text);
  console.log(`\n${text}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
