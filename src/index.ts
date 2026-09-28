export {
  toDecimalString,
  toBigIntScaled,
  toNumber,
  formatScaledBigInt,
  isExactlyRepresentable,
  VALID_BIT_WIDTHS,
} from './decimal.ts';
export type { DecimalWords, DecimalTypeLike, ScaledBigInt, ToNumberOptions, DecimalBitWidth } from './decimal.ts';

export { decimalColumnToStrings, tableToRows } from './rows.ts';
export type { DecimalRepresentation, TableToRowsOptions } from './rows.ts';

export { ArrowDecimalError, InexactConversionError, UnsupportedBitWidthError } from './errors.ts';
