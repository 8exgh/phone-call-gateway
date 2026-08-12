export const SILENCE_FLOOR_DBFS = -96;

/** Root-mean-square level of a PCM16 frame in dBFS (0 = full scale). */
export function rmsDbfs(frame: Int16Array): number {
  if (frame.length === 0) return SILENCE_FLOOR_DBFS;
  let sumSquares = 0;
  for (let i = 0; i < frame.length; i++) {
    const n = frame[i]! / 32768;
    sumSquares += n * n;
  }
  return dbfsFromMeanPower(sumSquares / frame.length);
}

/** Mean power (of normalized samples) -> dBFS. 10*log10 because power is amplitude squared. */
export function dbfsFromMeanPower(meanPower: number): number {
  if (meanPower <= 0) return SILENCE_FLOOR_DBFS;
  return Math.max(SILENCE_FLOOR_DBFS, 10 * Math.log10(meanPower));
}

/** Sum of squared normalized samples, for accumulating power across frames. */
export function sumSquaresNormalized(frame: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const n = frame[i]! / 32768;
    sum += n * n;
  }
  return sum;
}
