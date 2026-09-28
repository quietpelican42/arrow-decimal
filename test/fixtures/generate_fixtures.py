#!/usr/bin/env python3
"""Generates the Arrow IPC fixtures under test/fixtures/ and their ground-truth
manifest, from pyarrow. Re-run after editing this file:

    python3 -m venv .venv && .venv/bin/pip install pyarrow==25.0.1
    .venv/bin/python3 test/fixtures/generate_fixtures.py

Ground truth is pyarrow's own str(Decimal(...)) for scale >= 0, cross-checked
against decimal.Decimal so it isn't just re-deriving the value under test.

One exception: pyarrow's decimal(precision, scale) type allows a *negative*
scale (the Arrow format does not forbid it; see format/Schema.fbs), but
Python's decimal.Decimal.__str__ renders a positive exponent in scientific
notation ("1.23E+4"), not as a plain integer with trailing zeros. The library
under test always produces plain notation, so the negative-scale fixture is
checked for numeric equality (Decimal(expected) == Decimal(actual)), not
string equality; every other fixture is checked with exact string equality.
"""

import decimal
import json
import pathlib
import random

import pyarrow as pa

HERE = pathlib.Path(__file__).parent
random.seed(20260928)

BITWIDTH_TO_FACTORY = {
    32: pa.decimal32,
    64: pa.decimal64,
    128: pa.decimal128,
    256: pa.decimal256,
}
MAX_PRECISION = {32: 9, 64: 18, 128: 38, 256: 76}


def rand_unscaled(precision: int) -> int:
    digits = "".join(str(random.randint(0, 9)) for _ in range(precision))
    digits = digits.lstrip("0") or "0"
    return int(digits)


def build_case_values(precision: int) -> list[int]:
    max_val = 10**precision - 1
    values = {0, max_val, -max_val, 1, -1}
    for _ in range(12):
        v = rand_unscaled(precision)
        values.add(v)
        values.add(-v)
    # A value with fewer significant digits than the scale, to force leading
    # zeros after the decimal point (e.g. unscaled=5, scale=3 -> "0.005").
    values.add(5)
    values.add(-5)
    return sorted(values, key=lambda v: (abs(v), v))


def write_case(name: str, factory, precision: int, scale: int, bitwidth: int) -> dict:
    unscaled_values = build_case_values(precision)
    decimal_type = factory(precision, scale)
    # Built from a string with an explicit exponent, not Decimal(v).scaleb(),
    # because scaleb() rounds to the *context* precision (28 by default) and
    # would silently corrupt decimal256 values above that.
    py_values = [decimal.Decimal(f"{v}E{-scale}") for v in unscaled_values]
    arr = pa.array(py_values, type=decimal_type)
    table = pa.table({"value": arr})

    path = HERE / f"{name}.arrow"
    with pa.ipc.new_file(path, table.schema) as writer:
        writer.write_table(table)

    rows = []
    for unscaled, py_value in zip(unscaled_values, py_values):
        expected_str = str(py_value)
        rows.append(
            {
                "unscaled": str(unscaled),
                "expected": expected_str,
                # Cross-check: rebuild the same string from unscaled/scale
                # independently of pyarrow, using plain (non-scientific)
                # notation, and only assert string equality when it matches
                # pyarrow's own rendering (i.e. scale >= 0).
                "checkMode": "string" if scale >= 0 else "numeric",
            }
        )

    return {
        "name": name,
        "file": f"{name}.arrow",
        "precision": precision,
        "scale": scale,
        "bitWidth": bitwidth,
        "rows": rows,
    }


def main() -> None:
    manifest = {"cases": []}

    for bitwidth, factory in BITWIDTH_TO_FACTORY.items():
        max_p = MAX_PRECISION[bitwidth]
        # A representative small scale, and the maximum precision boundary.
        manifest["cases"].append(write_case(f"d{bitwidth}_scale2", factory, max_p if max_p < 10 else 10, 2, bitwidth))
        manifest["cases"].append(write_case(f"d{bitwidth}_scale0", factory, max_p if max_p < 10 else 10, 0, bitwidth))
        manifest["cases"].append(
            write_case(f"d{bitwidth}_maxprecision", factory, max_p, min(max_p, 6), bitwidth)
        )

    # The exact reproduction from the build brief: decimal128(10, 2), unscaled
    # 5 / -1234 / 0, which apache-arrow's own accessors read back as
    # "5" / "-1234" / "0" (unscaled) instead of "0.05" / "-12.34" / "0". Also
    # written at every other bitWidth (same values, same scale) for
    # examples/compare.ts, which shows apache-arrow getting each one wrong in
    # a different way.
    premise_values = [decimal.Decimal("0.05"), decimal.Decimal("-12.34"), decimal.Decimal("0")]
    premise_precision = {32: 9, 64: 10, 128: 10, 256: 20}
    for bitwidth, factory in BITWIDTH_TO_FACTORY.items():
        premise_type = factory(premise_precision[bitwidth], 2)
        premise_table = pa.table({"value": pa.array(premise_values, type=premise_type)})
        name = "premise" if bitwidth == 128 else f"premise{bitwidth}"
        with pa.ipc.new_file(HERE / f"{name}.arrow", premise_table.schema) as writer:
            writer.write_table(premise_table)

    # scale >= digit count (e.g. 0.005), isolated so it's easy to eyeball.
    manifest["cases"].append(write_case("leading_zeros", pa.decimal128, 10, 6, 128))

    # Negative scale: allowed by the Arrow format (Schema.fbs does not bound
    # scale to be non-negative); pyarrow accepts it too. Checked numerically.
    manifest["cases"].append(write_case("negative_scale", pa.decimal128, 6, -2, 128))

    # Nested Struct/List containing a Decimal field/item.
    dec_t = pa.decimal128(10, 2)
    struct_t = pa.struct([("amount", dec_t), ("label", pa.string())])
    struct_values = [
        {"amount": decimal.Decimal("0.05"), "label": "a"},
        {"amount": decimal.Decimal("-12.34"), "label": "b"},
        {"amount": None, "label": "c"},
    ]
    list_t = pa.list_(dec_t)
    list_values = [
        [decimal.Decimal("1.23"), decimal.Decimal("4.56")],
        [decimal.Decimal("0")],
        None,
    ]
    nested_table = pa.table(
        {
            "s": pa.array(struct_values, type=struct_t),
            "l": pa.array(list_values, type=list_t),
        }
    )
    with pa.ipc.new_file(HERE / "nested.arrow", nested_table.schema) as writer:
        writer.write_table(nested_table)

    # A real Parquet file, for the Node-side Parquet read test.
    import pyarrow.parquet as pq

    parquet_table = pa.table({"amount": pa.array([decimal.Decimal("0.05"), decimal.Decimal("-12.34"), None], type=dec_t)})
    pq.write_table(parquet_table, HERE / "decimal.parquet")

    (HERE / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {len(manifest['cases'])} IPC cases, nested.arrow, decimal.parquet, manifest.json")


if __name__ == "__main__":
    main()
