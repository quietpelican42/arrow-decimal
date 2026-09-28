import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { tableFromIPC } from 'apache-arrow';

import {
  toDecimalString,
  toBigIntScaled,
  toNumber,
  formatScaledBigInt,
  isExactlyRepresentable,
} from '../src/decimal.ts';
import { InexactConversionError, UnsupportedBitWidthError } from '../src/errors.ts';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
function loadFixtureColumn(name: string) {
  const table = tableFromIPC(fs.readFileSync(path.join(fixturesDir, `${name}.arrow`)));
  const vector = table.getChild('value')!;
  return { table, vector };
}

test('premise: apache-arrow reads Decimal values unscaled (reproduces the build brief)', () => {
  const { vector } = loadFixtureColumn('premise');
  assert.equal(vector.type.scale, 2);
  assert.equal(vector.type.bitWidth, 128);

  // apache-arrow's own accessors ignore scale entirely.
  assert.equal(String(vector.get(0)), '5');
  assert.equal(String(vector.get(1)), '-1234');
  assert.equal(String(vector.get(2)), '0');
  assert.equal(Number(vector.get(0)), 5);
  assert.equal(Number(vector.get(1)), -1234);

  // The correctly-scaled values (pyarrow's str(Decimal) keeps the scale's
  // trailing zeros on zero too: str(Decimal("0.00")) == "0.00").
  assert.equal(toDecimalString(vector.get(0)!, vector.type), '0.05');
  assert.equal(toDecimalString(vector.get(1)!, vector.type), '-12.34');
  assert.equal(toDecimalString(vector.get(2)!, vector.type), '0.00');
});

test('premise across every bitWidth: apache-arrow breaks differently at each width, this library does not', () => {
  const cases: [name: string, bitWidth: number][] = [
    ['premise32', 32],
    ['premise64', 64],
    ['premise', 128],
    ['premise256', 256],
  ];
  for (const [name, bitWidth] of cases) {
    const { vector } = loadFixtureColumn(name);
    assert.equal(vector.type.bitWidth, bitWidth);
    assert.equal(toDecimalString(vector.get(0)!, vector.type), '0.05');
    assert.equal(toDecimalString(vector.get(1)!, vector.type), '-12.34');
    assert.equal(toDecimalString(vector.get(2)!, vector.type), '0.00');
  }

  // The specific apache-arrow failure modes documented in the README.
  const d64 = loadFixtureColumn('premise64').vector;
  assert.equal(String(d64.get(1)), '18446744073709550382'); // sign dropped
  const d256 = loadFixtureColumn('premise256').vector;
  assert.equal(String(d256.get(1)), '-4'); // wrong digits
  const d32 = loadFixtureColumn('premise32').vector;
  assert.throws(() => Number(d32.get(0)));
});

test('formatScaledBigInt: scale 0, positive scale, negative scale, zero', () => {
  assert.equal(formatScaledBigInt(1234n, 0), '1234');
  assert.equal(formatScaledBigInt(-1234n, 0), '-1234');
  assert.equal(formatScaledBigInt(0n, 0), '0');
  assert.equal(formatScaledBigInt(5n, 2), '0.05');
  assert.equal(formatScaledBigInt(-5n, 2), '-0.05');
  assert.equal(formatScaledBigInt(0n, 2), '0.00');
  assert.equal(formatScaledBigInt(1234n, 2), '12.34');
  assert.equal(formatScaledBigInt(-1234n, 2), '-12.34');
  // scale >= digit count: leading zeros after the point.
  assert.equal(formatScaledBigInt(5n, 3), '0.005');
  assert.equal(formatScaledBigInt(-5n, 3), '-0.005');
  // negative scale: plain notation with trailing zeros.
  assert.equal(formatScaledBigInt(123n, -2), '12300');
  assert.equal(formatScaledBigInt(-123n, -2), '-12300');
});

test('toBigIntScaled: two\'s complement is correct at every Arrow bitWidth', () => {
  // -1 in two's complement is all-ones at any width.
  assert.equal(toBigIntScaled(Uint32Array.of(0xffffffff), { scale: 0, bitWidth: 32 }).unscaled, -1n);
  assert.equal(
    toBigIntScaled(Uint32Array.of(0xffffffff, 0xffffffff), { scale: 0, bitWidth: 64 }).unscaled,
    -1n,
  );
  assert.equal(
    toBigIntScaled(Uint32Array.of(0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff), { scale: 0, bitWidth: 128 })
      .unscaled,
    -1n,
  );
  assert.equal(
    toBigIntScaled(
      Uint32Array.of(0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff),
      { scale: 0, bitWidth: 256 },
    ).unscaled,
    -1n,
  );

  // -1234 at bitWidth 64 (the width where apache-arrow's own String() falls
  // back to an *unsigned* rendering — see README).
  const negWords64 = Uint32Array.of(0xfffffb2e, 0xffffffff); // two's complement of 1234 over 64 bits
  assert.equal(toBigIntScaled(negWords64, { scale: 2, bitWidth: 64 }).unscaled, -1234n);

  // Minimum representable value at bitWidth 32 (top bit set, rest zero) = -2^31.
  const minWord32 = Uint32Array.of(0x80000000);
  assert.equal(toBigIntScaled(minWord32, { scale: 0, bitWidth: 32 }).unscaled, -(2n ** 31n));

  // Positive value that fills the top bit region without being negative
  // (largest positive 32-bit two's complement value).
  const maxWord32 = Uint32Array.of(0x7fffffff);
  assert.equal(toBigIntScaled(maxWord32, { scale: 0, bitWidth: 32 }).unscaled, 2n ** 31n - 1n);
});

test('toBigIntScaled: bitWidth defaults to word count * 32', () => {
  const result = toBigIntScaled(Uint32Array.of(500, 0, 0, 0), { scale: 2 });
  assert.deepEqual(result, { unscaled: 500n, scale: 2 });
});

test('toBigIntScaled: rejects an unsupported bitWidth', () => {
  assert.throws(() => toBigIntScaled(Uint32Array.of(1, 2, 3), { scale: 0, bitWidth: 96 }), UnsupportedBitWidthError);
});

test('toBigIntScaled: rejects a word count that does not match bitWidth', () => {
  assert.throws(() => toBigIntScaled(Uint32Array.of(1, 2), { scale: 0, bitWidth: 128 }), RangeError);
});

test('precision boundaries: decimal128 (precision 38) and decimal256 (precision 76)', () => {
  const maxDigits38 = '9'.repeat(38);
  const unscaled38 = BigInt(maxDigits38);
  assert.equal(formatScaledBigInt(unscaled38, 2), `${'9'.repeat(36)}.99`);

  const maxDigits76 = '9'.repeat(76);
  const unscaled76 = BigInt(maxDigits76);
  assert.equal(formatScaledBigInt(unscaled76, 2), `${'9'.repeat(74)}.99`);
});

test('isExactlyRepresentable: distinguishes exact and lossy decimals', () => {
  // 0.05 == 5 * 10^-2 == 1/20, no finite binary expansion.
  assert.equal(isExactlyRepresentable(5n, 2), false);
  // 0.25 == 1/4, exact in binary.
  assert.equal(isExactlyRepresentable(25n, 2), true);
  // Large integer scale 0, past 2^53.
  assert.equal(isExactlyRepresentable(2n ** 60n, 0), false);
  assert.equal(isExactlyRepresentable(12345n, 0), true);
  // Negative scale, still an integer under 2^53.
  assert.equal(isExactlyRepresentable(5n, -3), true);
});

test('toNumber: lossy by default, throws with { exact: true } on a lossy value', () => {
  const type = { scale: 2, bitWidth: 32 as const };
  const wordsForUnscaled5 = Uint32Array.of(5);
  assert.equal(toNumber(wordsForUnscaled5, type), 0.05);
  assert.throws(() => toNumber(wordsForUnscaled5, type, { exact: true }), InexactConversionError);

  const wordsForUnscaled25 = Uint32Array.of(25);
  assert.equal(toNumber(wordsForUnscaled25, type, { exact: true }), 0.25);
});

test('toDecimalString: scale 0 has no decimal point', () => {
  assert.equal(toDecimalString(Uint32Array.of(42), { scale: 0, bitWidth: 32 }), '42');
});
