import { Type } from 'apache-arrow';
import type { DataType, Field, Table, Vector } from 'apache-arrow';
import { toBigIntScaled, toDecimalString, toNumber } from './decimal.ts';
import type { DecimalWords } from './decimal.ts';

/** How `tableToRows` represents a Decimal value. */
export type DecimalRepresentation = 'string' | 'number' | 'bigint-pair';

export interface TableToRowsOptions {
  decimal: DecimalRepresentation;
}

function convertDecimal(value: DecimalWords, type: DataType, mode: DecimalRepresentation): unknown {
  switch (mode) {
    case 'string':
      return toDecimalString(value, type as unknown as { scale: number; bitWidth?: number });
    case 'number':
      return toNumber(value, type as unknown as { scale: number; bitWidth?: number });
    case 'bigint-pair':
      return toBigIntScaled(value, type as unknown as { scale: number; bitWidth?: number });
  }
}

/**
 * Applies decimal scaling to one value already read off a Vector (or a field
 * of a struct row, or an element of a list), recursing into Struct and List
 * children. Every other type is returned unchanged, i.e. exactly what
 * `vector.get(i)` / `table.toArray()` would already give.
 */
function convertValue(value: unknown, type: DataType, mode: DecimalRepresentation): unknown {
  if (value === null || value === undefined) return null;

  switch (type.typeId) {
    case Type.Decimal:
      return convertDecimal(value as DecimalWords, type, mode);

    case Type.Struct: {
      const result: Record<string, unknown> = {};
      for (const field of type.children as Field[]) {
        result[field.name] = convertValue((value as Record<string, unknown>)[field.name], field.type, mode);
      }
      return result;
    }

    case Type.List:
    case Type.FixedSizeList: {
      const childType = (type.children as Field[])[0]!.type;
      const childVector = value as Vector;
      const result: unknown[] = new Array(childVector.length);
      for (let i = 0; i < childVector.length; i++) {
        result[i] = convertValue(childVector.get(i), childType, mode);
      }
      return result;
    }

    default:
      return value;
  }
}

/**
 * Reads every value of a Decimal Vector as an exact string, e.g.
 * `["0.05", "-12.34", "0", null]`. Equivalent to mapping `toDecimalString`
 * over the column, with null slots passed through.
 */
export function decimalColumnToStrings(vector: Vector): (string | null)[] {
  const out: (string | null)[] = new Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    const value = vector.get(i);
    out[i] = value === null ? null : toDecimalString(value as DecimalWords, vector.type);
  }
  return out;
}

/**
 * `table.toArray()`, but every Decimal field — including one nested inside a
 * Struct or List column — is correctly scaled instead of left as a raw
 * unscaled two's-complement integer.
 */
export function tableToRows(table: Table, options: TableToRowsOptions): Record<string, unknown>[] {
  const fields = table.schema.fields;
  const vectors = fields.map((field) => table.getChild(field.name));
  const rows: Record<string, unknown>[] = new Array(table.numRows);

  for (let i = 0; i < table.numRows; i++) {
    const row: Record<string, unknown> = {};
    for (let f = 0; f < fields.length; f++) {
      const field = fields[f]!;
      const vector = vectors[f];
      row[field.name] = vector == null ? null : convertValue(vector.get(i), field.type, options.decimal);
    }
    rows[i] = row;
  }
  return rows;
}
