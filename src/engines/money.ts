/**
 * Money is BIGINT paise (docs/fincalc-2.0/05 L1) and a JSON *string* on the wire
 * (07 §2). Never a float in storage or transport.
 *
 * Engine arithmetic is done in float rupees and rounded to paise at the boundary.
 * That is deliberate and matches the Dart engine in fincalc_core: both sides run
 * the same IEEE-754 double operations in the same order, so the shared golden
 * vectors (T1) pin them to the same value. Using Decimal on one side and double
 * on the other is exactly how the two engines would silently diverge.
 */

export type Paise = bigint

/** Rupees (float) → paise (bigint), half-up at the paisa. */
export function toPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) throw new RangeError('toPaise: non-finite')
  return BigInt(Math.round(rupees * 100))
}

export function toRupees(paise: Paise): number {
  return Number(paise) / 100
}

/**
 * Rupees → paise, rounded UP.
 *
 * Used for any "how much must I invest / pay?" answer. Rounding to nearest would
 * round down half the time, and a required-contribution figure that rounds down
 * lands the user BELOW their target — at a 15-year horizon a half-paisa shortfall
 * compounds to several rupees. Always overshoot a requirement, never undershoot it.
 */
export function toPaiseCeil(rupees: number): Paise {
  if (!Number.isFinite(rupees)) throw new RangeError('toPaiseCeil: non-finite')
  // 1e-9 absorbs binary-float noise so an exact value is not pushed up a paisa.
  return BigInt(Math.ceil(rupees * 100 - 1e-9))
}

/** Wire form: an exact decimal string of integer paise. */
export function paiseToWire(paise: Paise): string {
  return paise.toString()
}

/** Parse the wire form. Accepts a string (canonical) or a number (tolerated on input). */
export function wireToPaise(v: string | number | bigint): Paise {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new RangeError('wireToPaise: paise must be an integer')
    return BigInt(v)
  }
  if (!/^-?\d+$/.test(v)) throw new RangeError(`wireToPaise: not integer paise: ${v}`)
  return BigInt(v)
}

/**
 * Rates are INTEGER micro-units (05 L2): 12.5 % → 125000.
 * Kept as integers so a rate never picks up float drift between the two engines.
 */
export type RateMicro = number

export function microToFraction(micro: RateMicro): number {
  return micro / 1_000_000
}

export function fractionToMicro(fraction: number): RateMicro {
  return Math.round(fraction * 1_000_000)
}

/** ₹1,23,456.78 — the Indian grouping (last 3, then pairs). */
export function formatIndian(paise: Paise): string {
  const neg = paise < 0n
  const abs = neg ? -paise : paise
  const whole = (abs / 100n).toString()
  const frac = (abs % 100n).toString().padStart(2, '0')

  let grouped: string
  if (whole.length <= 3) {
    grouped = whole
  } else {
    const last3 = whole.slice(-3)
    const rest = whole.slice(0, -3)
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3
  }
  return `${neg ? '-' : ''}₹${grouped}.${frac}`
}
