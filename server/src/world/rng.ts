/**
 * Seeded randomness for the simulator. Every random choice in `server/src/world/**` goes
 * through an `Rng`, so a seed reproduces a run exactly (no `Math.random` here).
 */
export type Rng = () => number;

/** mulberry32: a small, fast 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Integer in [min, max], inclusive. */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** A uniformly chosen element, or undefined for an empty list. */
export function pick<T>(rng: Rng, items: readonly T[]): T | undefined {
  return items[Math.floor(rng() * items.length)];
}
