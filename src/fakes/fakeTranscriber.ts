import type { TranscriberCallbacks, TranscriberFactory, TranscriberSession } from '../speech/transcriber';
import { rmsDbfs } from '../prosody/rms';
import { VOLUME_THRESHOLDS_DBFS } from '../prosody/volume';
import { OPENAI_SAMPLE_RATE } from '../audio/frames';
import { scriptUtterances, type CallerScript } from './callerScript';

const MIN_UTTERANCE_VOICED_MS = 100;
const ENDPOINT_SILENCE_MS = 300;

/**
 * An honest fake: it watches the actual audio stream arriving through the real
 * plumbing (mu-law decode -> upsample), runs a simple energy endpointing
 * detector, and only when it has absorbed a real voiced utterance does it emit
 * the next scripted text — so the audio path is exercised end to end offline.
 */
class FakeTranscriberSession implements TranscriberSession {
  private utteranceIndex = 0;
  private voicedMs = 0;
  private silenceMs = 0;
  private inUtterance = false;
  private deltaSent = false;

  constructor(
    private readonly utterances: string[],
    private readonly callbacks: TranscriberCallbacks,
  ) {}

  sendAudio(pcm24k: Int16Array): void {
    const ms = pcm24k.length / (OPENAI_SAMPLE_RATE / 1000);
    const dbfs = rmsDbfs(pcm24k);
    if (dbfs >= VOLUME_THRESHOLDS_DBFS.silence) {
      this.voicedMs += ms;
      this.silenceMs = 0;
      if (!this.inUtterance && this.voicedMs >= MIN_UTTERANCE_VOICED_MS) {
        this.inUtterance = true;
        this.deltaSent = false;
      }
      if (this.inUtterance && !this.deltaSent) {
        const text = this.utterances[this.utteranceIndex];
        if (text !== undefined) {
          this.callbacks.onDelta(text.split(/\s+/).slice(0, 2).join(' '));
        }
        this.deltaSent = true;
      }
    } else {
      this.silenceMs += ms;
      if (this.inUtterance && this.silenceMs >= ENDPOINT_SILENCE_MS) {
        const text = this.utterances[this.utteranceIndex++];
        if (text !== undefined) {
          this.callbacks.onCompleted(text, 0.95);
        }
        this.inUtterance = false;
        this.voicedMs = 0;
      } else if (!this.inUtterance) {
        this.voicedMs = 0;
      }
    }
  }

  close(): void {
    // Nothing to release.
  }
}

export class FakeTranscriberFactory implements TranscriberFactory {
  constructor(private readonly script: CallerScript) {}

  create(callbacks: TranscriberCallbacks): TranscriberSession {
    return new FakeTranscriberSession(scriptUtterances(this.script), callbacks);
  }
}
