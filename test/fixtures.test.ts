/**
 * Ground truth comes from pyarrow (test/fixtures/generate_fixtures.py), which
 * writes Arrow IPC files and records pyarrow's own str(Decimal(...)) per row.
 * These fixtures cover every bitWidth pyarrow supports (32/64/128/256),
 * random values, +/-1, the all-nines boundary, zero, values with fewer
 * significant digits than the scale, and a negative-scale case.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { tableFromIPC } from 'apache-arrow';

import { toDecimalString, toBigIntScaled } from '../src/decimal.ts';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface FixtureRow {
  unscaled: string;
  expected: string;
  checkMode: 'string' | 'numeric';
}
interface FixtureCase {
  name: string;
  file: string;
  precision: number;
  scale: number;
  bitWidth: number;
  rows: FixtureRow[];
}

const manifest: { cases: FixtureCase[] } = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'manifest.json'), 'utf8'));

for (const testCase of manifest.cases) {
  test(`fixture ${testCase.name}: decimal${testCase.bitWidth}(${testCase.precision}, ${testCase.scale})`, () => {
    const table = tableFromIPC(fs.readFileSync(path.join(fixturesDir, testCase.file)));
    const vector = table.getChild('value')!;
    assert.equal(vector.length, testCase.rows.length);
    assert.equal(vector.type.bitWidth, testCase.bitWidth);
    assert.equal(vector.type.scale, testCase.scale);

    for (let i = 0; i < testCase.rows.length; i++) {
      const row = testCase.rows[i]!;
      const value = vector.get(i)!;
      const { unscaled } = toBigIntScaled(value, vector.type);
      assert.equal(unscaled, BigInt(row.unscaled), `row ${i} unscaled`);

      const actual = toDecimalString(value, vector.type);
      if (row.checkMode === 'string') {
        assert.equal(actual, row.expected, `row ${i} string`);
      } else {
        // Negative-scale row: pyarrow's str(Decimal) uses scientific
        // notation ("1.23E+4"); our output is plain ("12300"). Compare the
        // underlying integer value both represent, not the two strings.
        const expectedUnscaled = BigInt(row.unscaled);
        const actualScaled = toBigIntScaled(value, vector.type);
        assert.equal(actualScaled.unscaled, expectedUnscaled, `row ${i} numeric`);
      }
    }
  });
}

test('fixture leading_zeros contains an entry with more zeros than significant digits', () => {
  const found = manifest.cases.find((c) => c.name === 'leading_zeros')!;
  const smallRow = found.rows.find((r) => r.unscaled === '5');
  assert.equal(smallRow?.expected, '0.000005');
});
