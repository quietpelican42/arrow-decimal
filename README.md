# arrow-decimal

Reads `apache-arrow` Decimal values correctly scaled, at every bitWidth the format defines.

```ts
import { tableFromIPC } from 'apache-arrow';
import { toDecimalString } from 'arrow-decimal';

const table = tableFromIPC(bytes);
const vector = table.getChild('amount')!;

toDecimalString(vector.get(0)!, vector.type); // "0.05", not "5"
```

## Why

`apache-arrow` stores a `Decimal` as a fixed-width two's-complement integer plus
a `scale`, and every one of its own accessors — `String()`, `Number()`,
`JSON.stringify`, `util.bigNumToString`, and `table.toArray()` — hands back the
raw unscaled integer. Nothing applies the scale.

Measured: `node examples/compare.ts`, reading the same three values (0.05,
-12.34, 0) written at every bitWidth Arrow defines for Decimal, with
apache-arrow 21.2.0:

```
  decimal32(precision=9, scale=2)

    String()=5                            Number()=throws: Cannot mix BigInt and other types, use explicit conversions toDecimalString=0.05
    String()=-1234                        Number()=throws: start offset of BigUint64Array should be a multiple of 8 toDecimalString=-12.34
    String()=0                            Number()=throws: Cannot mix BigInt and other types, use explicit conversions toDecimalString=0.00

  decimal64(precision=10, scale=2)

    String()=5                            Number()=5                                  toDecimalString=0.05
    String()=18446744073709550382         Number()=-1234                              toDecimalString=-12.34
    String()=0                            Number()=0                                  toDecimalString=0.00

  decimal128(precision=10, scale=2)

    String()=5                            Number()=5                                  toDecimalString=0.05
    String()=-1234                        Number()=-1234                              toDecimalString=-12.34
    String()=0                            Number()=0                                  toDecimalString=0.00

  decimal256(precision=20, scale=2)

    String()=5                            Number()=5                                  toDecimalString=0.05
    String()=-4                           Number()=-1234                              toDecimalString=-12.34
    String()=0                            Number()=0                                  toDecimalString=0.00
```

Every bitWidth is broken in a different way: `decimal32` throws out of
`Number()` entirely; `decimal64`'s `String()` drops the sign and prints the
unsigned two's-complement value instead; `decimal256`'s `String()` prints the
wrong digits outright (`-4` instead of `-1234`). Only `decimal128` — the
default when a bitWidth isn't specified — gets the unscaled integer right,
and even it never applies the scale.

This isn't new or unfiled: [apache/arrow-js#77](https://github.com/apache/arrow-js/issues/77)
("all of the built-in conversions appear to be faulty"),
[#100](https://github.com/apache/arrow-js/issues/100) ("I know the value should
be 519.5 ... Is there some easier way to do that?"), and
[#81](https://github.com/apache/arrow-js/issues/81) ("it's essentially a
duplicate of apache/arrow-js#100 but it's been a couple of years ... there's no
way it handles Decimal256 properly") are all open. [#78](https://github.com/apache/arrow-js/issues/78)
tracks that the library's own docs don't explain how to read Decimal, Struct or
List data at all. Three projects that consume `apache-arrow` from JS have each
hand-rolled their own fix rather than wait: [streamlit's `formatDecimal`](https://github.com/streamlit/streamlit/blob/d10b8a1d105eb536774d9e6520d0e27ccabcdae9/frontend/lib/src/dataframes/arrowFormatUtils.ts#L346-L377)
(comment: `"This is only a temporary workaround until ArrowJS can format
decimals correctly"`), [graphic-walker's `scaledIntegerToDecimalString`](https://github.com/Kanaries/graphic-walker/blob/869f5af40fbdf7d1e4266b3df62d9dd6d8b5f728/packages/duckdb-wasm-computation/src/result.ts#L12-L17),
and duckdb-wasm, which sidesteps the bug from the C++ side instead of fixing it
in JS: a [`castDecimalToDouble` option](https://github.com/duckdb/duckdb-wasm/blob/def100b4be91a8ba27d441914e496231695ba0a8/lib/src/arrow_casts.cc)
that converts Decimal to Float64 before it ever reaches the JS bindings, with
[a regression test](https://github.com/duckdb/duckdb-wasm/blob/def100b4be91a8ba27d441914e496231695ba0a8/packages/duckdb-wasm/test/regression/github_477.test.ts)
noting "Arrow JS now handles negative decimals, but not the fractional part."

Checked for an existing fix: no npm package wraps `apache-arrow` to fix Decimal
scaling. [`@uwdata/flechette`](https://www.npmjs.com/package/@uwdata/flechette)
is a full alternative Arrow implementation that reads Decimal values already
scaled (verified: reading the same fixture gives `0.05`, `-12.34`, `0`
directly) — but adopting it means replacing `apache-arrow` everywhere in a
project, not adding one function.

## Installation

```sh
npm install arrow-decimal apache-arrow
```

Node >= 20.6. `apache-arrow` >= 17 is a peer dependency — this only converts
values it reads back from Vectors and Tables you already have. No other
runtime dependencies.

## Usage

### One value

```ts
import { toDecimalString } from 'arrow-decimal';

const vector = table.getChild('amount')!;
const value = vector.get(0);
if (value !== null) toDecimalString(value, vector.type); // "0.05"
```

### A whole column

```ts
import { decimalColumnToStrings } from 'arrow-decimal';

decimalColumnToStrings(table.getChild('amount')!); // ["0.05", "-12.34", null]
```

### A whole table, including nested Decimals

```ts
import { tableToRows } from 'arrow-decimal';

tableToRows(table, { decimal: 'string' });
// [{ amount: "0.05", account: { balance: "-12.34" } }, ...]
```

Everything that isn't a Decimal — including a Decimal inside a `Struct` or
`List` column — passes through exactly as `table.toArray()` would produce it.

### As an exact integer, or a lossy number

```ts
import { toBigIntScaled, toNumber } from 'arrow-decimal';

toBigIntScaled(value, vector.type); // { unscaled: -1234n, scale: 2 }
toNumber(value, vector.type); // -12.34 (a JS number; lossy above 2^53)
toNumber(value, vector.type, { exact: true }); // throws if that loses precision
```

## Reference

### `toDecimalString(value, type): string`

The exact base-10 string for one Decimal value, e.g. `"-12.34"`. Matches
pyarrow's `str(Decimal(...))` for `scale >= 0`.

### `toBigIntScaled(value, type): { unscaled: bigint; scale: number }`

The exact unscaled integer and the type's scale, with no string formatting.

### `toNumber(value, type, options?): number`

| Option  | Type      | Default | Description                                                        |
| ------- | --------- | ------- | -------------------------------------------------------------------|
| `exact` | `boolean` | `false` | Throw `InexactConversionError` instead of silently rounding.        |

Parses the exact decimal string rather than dividing floating-point numbers,
so the result is always the correctly-rounded double for that value.

### `decimalColumnToStrings(vector): (string \| null)[]`

Maps `toDecimalString` over every value in a Decimal `Vector`, passing `null`
through.

### `tableToRows(table, options): Record<string, unknown>[]`

| Option    | Type                              | Description                                      |
| --------- | ---------------------------------- | ------------------------------------------------|
| `decimal` | `'string' \| 'number' \| 'bigint-pair'` | How to represent every Decimal field, including ones nested in `Struct`/`List` columns. `'bigint-pair'` gives `{ unscaled, scale }`. |

### `formatScaledBigInt(unscaled, scale): string`

The formatting half of `toDecimalString`, for callers that already have an
unscaled `bigint` (e.g. from `toBigIntScaled`).

### `isExactlyRepresentable(unscaled, scale): boolean`

True if `unscaled * 10^-scale` has an exact IEEE-754 double representation.
Used internally by `toNumber({ exact: true })`; exported because it is useful
on its own.

### Errors

All extend `ArrowDecimalError`.

- `InexactConversionError` — `decimalString`. Thrown by `toNumber(..., { exact: true })`.
- `UnsupportedBitWidthError` — `bitWidth`. Thrown when a Decimal's bitWidth isn't 32, 64, 128 or 256.

`toBigIntScaled` also throws a plain `RangeError` if the value's word count
doesn't match its `type.bitWidth`.

## How it works

A Decimal value is one or more 32-bit little-endian words in two's complement
(`bitWidth / 32` of them). `toBigIntScaled` reassembles them into a native
`bigint` — reading the words high-to-low and shifting, then subtracting
`2^bitWidth` if the top bit is set — which handles any bitWidth uniformly and
sidesteps apache-arrow's own per-width bugs entirely, since the words are read
directly off the Vector's backing buffer rather than through `String()` or
`Number()`. Formatting then slices that integer's decimal digits at `scale`
from the right, padding with leading zeros first if the value has fewer
significant digits than the scale (e.g. `0.005`).

## Limitations

- Reads only. This library does not build or write Decimal columns.
- `tableToRows` recurses into `Struct` and `List`/`FixedSizeList` columns only;
  a Decimal inside a `Map` or a `Union` passes through unconverted, the same as
  `toArray()` would leave it.
- Negative scale is accepted (nothing in the Arrow format forbids it — see
  `format/Schema.fbs`) and formatted as a plain integer with trailing zeros.
  pyarrow's own `str(Decimal(...))` renders the same value in scientific
  notation instead (`"1.23E+4"`), so that one case is tested for numeric
  equality against pyarrow's output, not string equality — see
  `test/fixtures/generate_fixtures.py`.
- `toNumber` is inherently lossy outside the cases `isExactlyRepresentable`
  accepts; use `toDecimalString` or `toBigIntScaled` to keep full precision.

## Compatibility

Tested locally against `apache-arrow` 17.0.0 and 21.2.0, both with all 29
tests in `test/*.test.ts` passing (`node --test "test/*.test.ts"`, `TZ=UTC`,
macOS, Node 24). `decimal32` support in apache-arrow itself is broken in both
versions (see Why) — this library still reads it correctly by working from the
raw words instead of apache-arrow's accessors. The Parquet test additionally
depends on `parquet-wasm`, exercised in this same run.

Node >= 20.6 for the smoke tests against `dist/`; the TypeScript test suite
needs Node 24's type stripping. CI (`.github/workflows/test.yml`) runs both,
plus the same suite against apache-arrow 17.0.0 and 21.2.0 — those CI legs are
"run in CI", the versions above are what was actually run here.

## Development

```sh
npm install
npx tsc --noEmit
node --test "test/*.test.ts"
npm run build && npm run test:dist
```

Fixtures under `test/fixtures/` are generated by pyarrow:

```sh
python3 -m venv .venv && .venv/bin/pip install pyarrow==25.0.1
.venv/bin/python3 test/fixtures/generate_fixtures.py
```

## License

MIT. See [LICENSE](./LICENSE).
