/**
 * Signed tokens for the StockVirtue /fincalc market feed.
 *
 * WHY THIS EXISTS AT ALL. The feed accepts a raw `clientId:secret` key, and the
 * app could carry one directly — but a shipped APK cannot keep a secret. Anyone
 * who unpacks the binary reads the key, and revoking it means a Play Store
 * release for every existing install. Minting here keeps the long-lived secret
 * on a server we control: the app receives something that expires in fifteen
 * minutes, and rotating the secret takes effect on the next mint.
 *
 * THE FORMAT IS NOT OURS TO CHOOSE. The feed server verifies
 *
 *     sv1.<clientId>.<expUnixSeconds>.<base64url HMAC-SHA256 of the first three>
 *
 * so every part of it — the `sv1.` prefix, the separator, seconds not
 * milliseconds, base64url not base64 — has to match exactly or every connection
 * is refused with `unauthorized`, which deliberately says nothing about why.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export const TOKEN_VERSION = 'sv1'

export interface MintedToken {
  token: string
  /** Unix seconds. The app re-mints shortly before this. */
  expiresAt: number
}

/**
 * A dot is the field separator, so a clientId containing one would shift every
 * position and produce a token the feed parses as a different id entirely — or
 * as malformed. Checked rather than assumed: the value comes from an
 * environment variable, and the failure would look like an auth problem.
 */
export function assertValidClientId(clientId: string): void {
  if (!clientId) throw new Error('FEED_CLIENT_ID is empty')
  if (clientId.includes('.')) {
    throw new Error(
      `FEED_CLIENT_ID must not contain "." (got "${clientId}") — ` +
        'the dot is the token field separator.',
    )
  }
}

export function mintFeedToken(
  clientId: string,
  secret: string,
  ttlSeconds = 900,
  now: number = Date.now(),
): MintedToken {
  assertValidClientId(clientId)
  if (!secret) throw new Error('FEED_TOKEN_SECRET is empty')

  // SECONDS. Date.now() is milliseconds, and passing those through would mint a
  // token expiring in the year 58000 — accepted by a server that only compares
  // exp against the clock, and silently permanent.
  const exp = Math.floor(now / 1000) + ttlSeconds
  const body = `${TOKEN_VERSION}.${clientId}.${exp}`
  const sig = createHmac('sha256', secret).update(body).digest('base64url')

  return { token: `${body}.${sig}`, expiresAt: exp }
}

/**
 * Verify a token we minted. Not used to serve requests — the feed server does
 * the real verification — but it lets the test suite prove the exact bytes we
 * emit are the bytes that verify, which is the property that actually matters
 * and cannot be checked by reading the string.
 */
export function verifyFeedToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): { valid: boolean; reason?: string; clientId?: string } {
  const parts = token.split('.')
  if (parts.length !== 4) return { valid: false, reason: 'malformed' }

  const [version, clientId, expRaw, sig] = parts as [string, string, string, string]
  if (version !== TOKEN_VERSION) return { valid: false, reason: 'version' }

  const exp = Number(expRaw)
  if (!Number.isInteger(exp)) return { valid: false, reason: 'malformed' }

  const expected = createHmac('sha256', secret)
    .update(`${version}.${clientId}.${expRaw}`)
    .digest('base64url')

  // Constant time, and length-checked first because timingSafeEqual throws on a
  // length mismatch rather than returning false.
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: 'signature' }
  }

  // Signature before expiry: an expired token with a forged signature should
  // report as forged, not as merely stale.
  if (exp * 1000 <= now) return { valid: false, reason: 'expired' }

  return { valid: true, clientId }
}
