/**
 * Plain-JS checks against the built package, so they run on every Node version
 * in `engines` — the TypeScript suite needs type stripping and only runs on 24+.
 *
 *   npm run build && node --test test/smoke.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { tableFromIPC } from 'apache-arrow';

const { toDecimalString, toBigIntScaled, toNumber, decimalColumnToStrings, tableToRows } = await import(
  '../dist/index.js'
);

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const premise = tableFromIPC(fs.readFileSync(path.join(fixturesDir, 'premise.arrow')));
const vector = premise.getChild('value');

test('toDecimalString scales the premise values correctly', () => {
  assert.equal(toDecimalString(vector.get(0), vector.type), '0.05');
  assert.equal(toDecimalString(vector.get(1), vector.type), '-12.34');
  assert.equal(toDecimalString(vector.get(2), vector.type), '0.00');
});

test('toBigIntScaled returns the exact unscaled integer and scale', () => {
  assert.deepEqual(toBigIntScaled(vector.get(1), vector.type), { unscaled: -1234n, scale: 2 });
});

test('toNumber is lossy but matches for small values', () => {
  assert.equal(toNumber(vector.get(0), vector.type), 0.05);
});

test('decimalColumnToStrings scales a whole column', () => {
  assert.deepEqual(decimalColumnToStrings(vector), ['0.05', '-12.34', '0.00']);
});

test('tableToRows scales nested Decimal fields', () => {
  const nested = tableFromIPC(fs.readFileSync(path.join(fixturesDir, 'nested.arrow')));
  const rows = tableToRows(nested, { decimal: 'string' });
  assert.deepEqual(rows[0], { s: { amount: '0.05', label: 'a' }, l: ['1.23', '4.56'] });
});
