import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { tableFromIPC } from 'apache-arrow';

import { decimalColumnToStrings, tableToRows } from '../src/rows.ts';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('decimalColumnToStrings: scales every value, passes nulls through', () => {
  const table = tableFromIPC(fs.readFileSync(path.join(fixturesDir, 'premise.arrow')));
  const vector = table.getChild('value')!;
  assert.deepEqual(decimalColumnToStrings(vector), ['0.05', '-12.34', '0.00']);
});

test('tableToRows: scales a Decimal nested in a Struct and in a List, leaves other fields alone', () => {
  const table = tableFromIPC(fs.readFileSync(path.join(fixturesDir, 'nested.arrow')));

  const asStrings = tableToRows(table, { decimal: 'string' });
  assert.deepEqual(asStrings, [
    { s: { amount: '0.05', label: 'a' }, l: ['1.23', '4.56'] },
    { s: { amount: '-12.34', label: 'b' }, l: ['0.00'] },
    { s: { amount: null, label: 'c' }, l: null },
  ]);

  const asNumbers = tableToRows(table, { decimal: 'number' });
  assert.equal(asNumbers[0]!['s']!['amount' as never], 0.05);
  assert.deepEqual(asNumbers[1]!['l'], [0]);

  const asBigIntPairs = tableToRows(table, { decimal: 'bigint-pair' });
  const row0 = asBigIntPairs[0] as { s: { amount: { unscaled: bigint; scale: number } } };
  assert.deepEqual(row0.s.amount, { unscaled: 5n, scale: 2 });
});

test('tableToRows: non-decimal columns pass through exactly like toArray()', () => {
  const table = tableFromIPC(fs.readFileSync(path.join(fixturesDir, 'nested.arrow')));
  const rows = tableToRows(table, { decimal: 'string' });
  const viaToArray = table.toArray();
  for (let i = 0; i < rows.length; i++) {
    assert.equal((rows[i] as { s: { label: string } }).s.label, (viaToArray[i] as any).s?.label ?? null);
  }
});
