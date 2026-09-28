/** Base class for every error this library throws. */
export class ArrowDecimalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** `toNumber(value, type, { exact: true })` was called and the value cannot round-trip through a double. */
export class InexactConversionError extends ArrowDecimalError {
  decimalString: string;

  constructor(decimalString: string) {
    super(
      `Decimal value ${decimalString} cannot be represented exactly as a JavaScript number; ` +
        `use toDecimalString or toBigIntScaled instead, or drop the exact option`,
    );
    this.decimalString = decimalString;
  }
}

/** A word array with a length that doesn't correspond to a valid Arrow Decimal bitWidth. */
export class UnsupportedBitWidthError extends ArrowDecimalError {
  bitWidth: number;

  constructor(bitWidth: number) {
    super(`Unsupported Decimal bitWidth ${bitWidth} (Arrow defines 32, 64, 128 and 256)`);
    this.bitWidth = bitWidth;
  }
}
