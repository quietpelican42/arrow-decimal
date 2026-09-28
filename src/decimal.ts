import { UnsupportedBitWidthError, InexactConversionError } from './errors.ts';

/** The Arrow bitWidths a Decimal value can be stored in. */
export const VALID_BIT_WIDTHS = [32, 64, 128, 256] as const;
export type DecimalBitWidth = (typeof VALID_BIT_WIDTHS)[number];

/**
 * The little-endian, two's-complement backing store of one Decimal value: one
 * 32-bit word per `bitWidth / 32`. This is exactly the shape apache-arrow's
 * `vector.get(i)` returns for a Decimal column (its `BN` wrapper is a
 * `Uint32Array` subclass), so a value read from a Vector can be passed straight
 * through without conversion.
 */
export type DecimalWords = ArrayLike<number>;

/** The subset of apache-arrow's `Decimal` type that these functions need. */
export interface DecimalTypeLike {
  scale: number;
  /** Defaults to `value.length * 32` when omitted. */
  bitWidth?: number;
}

/** An exact Decimal value as an unscaled integer plus its scale. */
export interface ScaledBigInt {
  /** The raw integer, ignoring the decimal point (may be negative). */
  unscaled: bigint;
  /** Digits after the decimal point. Zero or negative per the Arrow spec. */
  scale: number;
}

function resolveBitWidth(words: DecimalWords, type: DecimalTypeLike): number {
  const bitWidth = type.bitWidth ?? words.length * 32;
  if (!(VALID_BIT_WIDTHS as readonly number[]).includes(bitWidth)) {
    throw new UnsupportedBitWidthError(bitWidth);
  }
  const expectedWords = bitWidth / 32;
  if (words.length !== expectedWords) {
    throw new RangeError(
      `Decimal value has ${words.length} 32-bit words but bitWidth ${bitWidth} needs ${expectedWords}`,
    );
  }
  return bitWidth;
}

/**
 * Reassembles the little-endian 32-bit words of a Decimal value into the exact
 * unscaled integer, correctly handling two's-complement negatives at any
 * bitWidth. This is the operation apache-arrow's own `String()`, `Number()`,
 * `util.bigNumToString` and `JSON.stringify` get wrong (see README).
 */
export function toBigIntScaled(value: DecimalWords, type: DecimalTypeLike): ScaledBigInt {
  const bitWidth = resolveBitWidth(value, type);
  const wordCount = bitWidth / 32;

  let magnitude = 0n;
  for (let i = wordCount - 1; i >= 0; i--) {
    const word = BigInt(value[i]! >>> 0);
    magnitude = (magnitude << 32n) | word;
  }

  const topWord = value[wordCount - 1]! >>> 0;
  const isNegative = (topWord & 0x80000000) !== 0;
  const unscaled = isNegative ? magnitude - (1n << BigInt(bitWidth)) : magnitude;

  return { unscaled, scale: type.scale };
}

/** Formats an already-decoded `{unscaled, scale}` pair as a plain decimal string. */
export function formatScaledBigInt(unscaled: bigint, scale: number): string {
  const negative = unscaled < 0n;
  const digits = (negative ? -unscaled : unscaled).toString(10);
  const sign = negative ? '-' : '';

  if (scale === 0) {
    return sign + digits;
  }
  if (scale < 0) {
    // Negative scale: the value is unscaled * 10^-scale, an integer with
    // trailing zeros. The Arrow format allows a negative scale (see README);
    // pyarrow's own str(Decimal) renders this in scientific notation instead,
    // which is why fixtures for this case are checked numerically, not by
    // string equality (see test/fixtures/generate_fixtures.py).
    return sign + digits + '0'.repeat(-scale);
  }

  const padded = digits.length <= scale ? digits.padStart(scale + 1, '0') : digits;
  const wholePart = padded.slice(0, padded.length - scale);
  const fractionPart = padded.slice(padded.length - scale);
  return `${sign}${wholePart}.${fractionPart}`;
}

/**
 * Converts a Decimal value to its exact base-10 string, e.g. `"-12.34"`.
 * Matches pyarrow's `str(Decimal(...))` for scale >= 0.
 */
export function toDecimalString(value: DecimalWords, type: DecimalTypeLike): string {
  const { unscaled, scale } = toBigIntScaled(value, type);
  return formatScaledBigInt(unscaled, scale);
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * True when `unscaled * 10^-scale` has an exact IEEE-754 double representation,
 * checked with exact integer arithmetic (no floating point involved).
 *
 * `unscaled / 10^scale` is exactly representable in binary iff, after removing
 * the `5^scale` factor from the denominator (leaving only a power of two),
 * the remaining numerator's magnitude fits the 53-bit double mantissa.
 */
export function isExactlyRepresentable(unscaled: bigint, scale: number): boolean {
  if (scale <= 0) {
    const value = unscaled * 10n ** BigInt(-scale);
    const abs = value < 0n ? -value : value;
    return abs <= MAX_SAFE_BIGINT;
  }
  const five = 5n ** BigInt(scale);
  if (unscaled % five !== 0n) return false;
  const numerator = unscaled / five;
  const abs = numerator < 0n ? -numerator : numerator;
  return abs < 1n << 53n;
}

export interface ToNumberOptions {
  /** Throw `InexactConversionError` instead of silently rounding. Default false. */
  exact?: boolean;
}

/**
 * Converts a Decimal value to a JavaScript `number`. Lossy above 2^53 or when
 * the fraction has no exact binary form (see `isExactlyRepresentable`).
 * Parses the exact decimal string rather than doing floating-point division,
 * so the result is always the correctly-rounded double for that string
 * (`Number()` on a numeric string literal is specified to round correctly).
 */
export function toNumber(value: DecimalWords, type: DecimalTypeLike, options: ToNumberOptions = {}): number {
  const { unscaled, scale } = toBigIntScaled(value, type);
  const decimalString = formatScaledBigInt(unscaled, scale);
  if (options.exact && !isExactlyRepresentable(unscaled, scale)) {
    throw new InexactConversionError(decimalString);
  }
  return Number(decimalString);
}
