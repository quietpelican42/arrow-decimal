/**
 * apache-arrow itself has no Parquet reader (it only speaks IPC/Feather). This
 * test exercises the ecosystem path that does exist in Node: parquet-wasm
 * (Rust, compiled to WebAssembly) decodes a real Parquet file into an Arrow
 * IPC stream, which apache-arrow then reads normally. test/fixtures/decimal.parquet
 * is written by pyarrow (see generate_fixtures.py).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { tableFromIPC } from 'apache-arrow';

import { decimalColumnToStrings } from '../src/rows.ts';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('reads a decimal column through a real Parquet file (via parquet-wasm)', async (t) => {
  let readParquet: (bytes: Uint8Array) => { intoIPCStream(): Uint8Array };
  try {
    ({ readParquet } = await import('parquet-wasm/node'));
  } catch {
    t.skip('parquet-wasm is not installed; run `npm install` (devDependency) to exercise the Parquet path');
    return;
  }

  const parquetPath = path.join(fixturesDir, 'decimal.parquet');
  if (!fs.existsSync(parquetPath)) {
    t.skip(`${parquetPath} missing; run test/fixtures/generate_fixtures.py`);
    return;
  }

  const bytes = fs.readFileSync(parquetPath);
  const parquetTable = readParquet(new Uint8Array(bytes));
  const table = tableFromIPC(parquetTable.intoIPCStream());
  const vector = table.getChild('amount')!;

  assert.equal(vector.type.bitWidth, 128);
  assert.equal(vector.type.scale, 2);
  assert.deepEqual(decimalColumnToStrings(vector), ['0.05', '-12.34', null]);
});
