export const SCALE = 100;

export function toPercent(fraction) {
  return fraction * SCALE;
}

export function fromPercent(percent) {
  return percent * SCALE;
}
