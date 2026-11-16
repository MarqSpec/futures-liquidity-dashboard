const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const bits = new DataView(new ArrayBuffer(8));

/** Starting state of an FNV-1a hash. */
export function fnvStart(): number {
  return FNV_OFFSET;
}

/** Eight hex characters, stable for a given hash. */
export function fnvHex(hash: number): string {
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Mixes values with FNV-1a. A separator after each value stops adjacent fields from cancelling the way a sum does.
 */
export function mix(hash: number, values: readonly (string | number | boolean | null | undefined)[]): number {
  for (const value of values) {
    const text = value === null || value === undefined ? "" : String(value);
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, FNV_PRIME);
    }
    hash ^= 0x1f;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash;
}

/**
 * Mixes a flat run of numbers by their float64 bits, so two different cells cannot add up to the same key.
 * Non-finite values collapse to one code each: they do not paint a distinct pixel.
 */
export function mixNumbers(hash: number, values: readonly number[]): number {
  for (let index = 0; index < values.length; index++) {
    hash = mixFloat(hash, values[index] ?? 0);
  }
  hash ^= values.length;
  hash = Math.imul(hash, FNV_PRIME);
  return hash;
}

function mixFloat(hash: number, value: number): number {
  if (!Number.isFinite(value)) {
    hash ^= Number.isNaN(value) ? 1 : value > 0 ? 2 : 3;
    hash = Math.imul(hash, FNV_PRIME);
    hash ^= 0x1f;
    return Math.imul(hash, FNV_PRIME);
  }
  // Non-negative integers stay on this path so a footprint cell does not pay for a float64 split.
  if (Number.isInteger(value) && value >= 0 && value <= 0x1fffffffffffff) {
    hash ^= value >>> 0;
    hash = Math.imul(hash, FNV_PRIME);
    hash ^= Math.trunc(value / 0x100000000);
    hash = Math.imul(hash, FNV_PRIME);
    hash ^= 0x1f;
    return Math.imul(hash, FNV_PRIME);
  }
  bits.setFloat64(0, value);
  hash ^= bits.getUint32(0);
  hash = Math.imul(hash, FNV_PRIME);
  hash ^= bits.getUint32(4);
  hash = Math.imul(hash, FNV_PRIME);
  hash ^= 0x1f;
  return Math.imul(hash, FNV_PRIME);
}
