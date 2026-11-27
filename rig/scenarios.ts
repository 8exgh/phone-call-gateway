/**
 * One agent persona for every scenario; a scenario is a way the CALLER behaves.
 * Each caller line carries what a natural agent should do in response.
 */

export const PERSONA = {
  goal:
    'You are Ava, the receptionist at Riverside Dental Clinic. Help the caller with whatever they ask. ' +
    'To book an appointment collect, in this order and one at a time: their full name, a callback phone number, ' +
    'then the day and time they prefer; read the details back, get a yes, then say goodbye. ' +
    'Clinic facts: open Monday to Friday 8am to 6pm, Saturday 9am to 1pm, closed Sunday. ' +
    'Address: 214 Riverside Drive, with free parking behind the building. ' +
    'A new patient exam and cleaning costs 189 dollars. Cancellations need 24 hours notice or there is a 50 dollar fee. ' +
    'Open slots this week: Tuesday 10:30am, Wednesday 2pm, Thursday 9am, Friday 4:15pm. ' +
    'Everything you need is in this prompt: do not use tools. When the caller says goodbye, say goodbye and end the call.',
  openingLine: 'Riverside Dental, this is Ava. How can I help you?',
};

export type Expect =
  /** The agent should answer once this line ends. */
  | 'reply'
  /** The caller is mid-thought (a pause follows, then more): the agent must stay quiet. */
  | 'hold'
  /** Spoken over the agent as an interruption: the agent must stop, then answer. */
  | 'bargein'
  /** Spoken over the agent as a listening noise ("mm-hmm"): the agent must keep going. */
  | 'backchannel';

export type Step =
  /** style: how the line is delivered (default: the scenario's style, else natural). */
  | { say: string; expect: Expect; style?: 'natural' | 'hesitant' | 'urgent' }
  /** Wait until the agent has spoken and then gone quiet (their turn is over). */
  | { waitAgentTurn: true; quietMs?: number; timeoutMs?: number }
  /** Wait until the agent has been talking continuously for this long. */
  | { waitAgentTalking: number; timeoutMs?: number }
  | { pause: number }
  | { hangup: true };

export interface Scenario {
  name: string;
  /** What this scenario probes, for the scorecard. */
  probes: string;
  /** How this caller talks unless a line says otherwise (default natural). */
  style?: 'natural' | 'hesitant' | 'urgent';
  /** Background noise mixed into the caller's side for the whole call (RMS, speech is ~2500). */
  noiseRms?: number;
  /** Agent-turn text must match each of these for the task to count as done. */
  success?: RegExp[];
  steps: Step[];
}

const turn = { waitAgentTurn: true } as const;

export const SCENARIOS: Scenario[] = [
  {
    name: 'booking',
    probes: 'multi-turn task, reply gap',
    success: [/mitchell/i, /thursday/i, /9\s?a\.?m|9:00|nine|\b9\b/i],
    steps: [
      turn,
      { say: "Hi, I'd like to book a cleaning appointment, please.", expect: 'reply' },
      turn,
      { say: 'Sarah Mitchell.', expect: 'reply' },
      turn,
      { say: "It's five eight seven, five five five, zero one four two.", expect: 'reply' },
      turn,
      { say: 'Thursday at nine works for me.', expect: 'reply' },
      turn,
      { say: "Yes, that's right. Thanks so much, bye.", expect: 'reply' },
      { waitAgentTurn: true, timeoutMs: 8000 },
      { pause: 1500 },
      { hangup: true },
    ],
  },
  {
    name: 'quick',
    probes: 'rapid short questions, reply gap',
    success: [/1\s?p\.?m|1:00|\bone\b/i, /189|one hundred/i, /parking|behind/i],
    steps: [
      turn,
      { say: 'What time do you close on Saturday?', expect: 'reply' },
      turn,
      { say: 'And how much is a new patient exam?', expect: 'reply' },
      turn,
      { say: 'Is there parking?', expect: 'reply' },
      turn,
      { say: 'Great, thanks. Bye.', expect: 'reply' },
      { waitAgentTurn: true, timeoutMs: 8000 },
      { pause: 1500 },
      { hangup: true },
    ],
  },
  {
    name: 'pauses',
    probes: 'a hesitant caller who pauses mid-sentence: no cut-offs',
    style: 'hesitant',
    success: [/24|twenty.four/i, /wednesday/i],
    steps: [
      turn,
      { say: 'Hi, um, I wanted to ask about', expect: 'hold' },
      { pause: 900 },
      { say: 'your cancellation policy.', expect: 'reply' },
      turn,
      { say: 'Okay. And if I wanted to come in this week, um,', expect: 'hold' },
      { pause: 1200 },
      { say: 'what do you have, like, midweek?', expect: 'reply' },
      turn,
      { say: 'Let me think.', expect: 'hold' },
      { pause: 1400 },
      // Delivered without the long inner pause: "Wednesday at two, I guess." followed by a
      // second of silence is a finished sentence, and answering it would be right.
      { say: 'Wednesday at two, I guess. My name is', expect: 'hold', style: 'natural' },
      { pause: 800 },
      { say: 'Sarah Mitchell.', expect: 'reply' },
      turn,
      { say: "Actually, I'll call back to finish booking. Thanks, bye.", expect: 'reply' },
      { waitAgentTurn: true, timeoutMs: 8000 },
      { pause: 1500 },
      { hangup: true },
    ],
  },
  {
    name: 'bargein',
    probes: 'caller interrupts: agent stops fast and answers the interruption',
    success: [/214|two fourteen|two one four/i, /189|one hundred/i],
    steps: [
      turn,
      { say: 'Can you tell me your hours, your address, and what the parking is like?', expect: 'reply' },
      { waitAgentTalking: 1200, timeoutMs: 15000 },
      { say: 'Sorry, sorry, actually, I just need the address.', expect: 'bargein', style: 'urgent' },
      turn,
      { say: 'Thanks. What is the cancellation policy, and how much is a new patient exam?', expect: 'reply' },
      { waitAgentTalking: 1200, timeoutMs: 15000 },
      { say: 'Wait, hang on, just the exam price please.', expect: 'bargein', style: 'urgent' },
      turn,
      { say: 'Perfect, thank you. Bye.', expect: 'reply' },
      { waitAgentTurn: true, timeoutMs: 8000 },
      { pause: 1500 },
      { hangup: true },
    ],
  },
  {
    name: 'backchannel',
    probes: '"mm-hmm" while the agent talks: agent keeps going',
    success: [/214|two fourteen|two one four/i, /189|one hundred/i],
    steps: [
      turn,
      { say: 'Can you tell me your hours, your address, and what the parking is like?', expect: 'reply' },
      { waitAgentTalking: 1500, timeoutMs: 15000 },
      { say: 'Mm-hmm.', expect: 'backchannel' },
      turn,
      { say: 'And what is the cancellation policy, and how much is a new patient exam?', expect: 'reply' },
      { waitAgentTalking: 1500, timeoutMs: 15000 },
      { say: 'Uh-huh.', expect: 'backchannel' },
      turn,
      { say: 'Got it, thanks. Bye.', expect: 'reply' },
      { waitAgentTurn: true, timeoutMs: 8000 },
      { pause: 1500 },
      { hangup: true },
    ],
  },
  {
    name: 'noisy',
    probes: 'background noise on the line: agent still speaks and answers',
    noiseRms: 450,
    success: [/1\s?p\.?m|1:00|\bone\b/i, /189|one hundred/i],
    steps: [
      turn,
      { say: 'What time do you close on Saturday?', expect: 'reply' },
      turn,
      { say: 'And how much is a new patient exam?', expect: 'reply' },
      turn,
      { say: 'Okay, thanks. Bye.', expect: 'reply' },
      { waitAgentTurn: true, timeoutMs: 8000 },
      { pause: 1500 },
      { hangup: true },
    ],
  },
];
