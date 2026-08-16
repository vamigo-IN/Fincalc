/**
 * Generates a JWT_SIGNING_KEYS value.
 *
 *   npm run keygen                      # a fresh single-key set
 *   npm run keygen -- --add k2          # adds a key to the CURRENT value, for rotation
 *
 * This exists because there was no way to produce a valid value except by hand,
 * and the format — base64 of a PKCS8 PEM, keyed by kid — is not one anybody
 * guesses correctly. A deploy where the operator typed something plausible into
 * JWT_SIGNING_KEYS is a deploy that crash-loops.
 *
 * Prints to stdout and nothing else, so the output can be pasted straight into
 * .env. It deliberately does NOT write .env itself: this is a secret, and a
 * script that silently rewrites the file holding every other secret is a script
 * that eventually destroys one.
 */
import { generateKeyPair, exportPKCS8, type CryptoKey } from 'jose'

async function newKeyBase64(): Promise<string> {
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true })
  const pem = await exportPKCS8(privateKey as CryptoKey)
  return Buffer.from(pem, 'utf8').toString('base64')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const addIdx = args.indexOf('--add')
  const kid = addIdx === -1 ? 'k1' : args[addIdx + 1]

  if (!kid) {
    console.error('--add needs a kid, e.g. --add k2')
    process.exitCode = 1
    return
  }

  const keys: Record<string, string> = {}

  // Rotation: keep the existing keys so tokens signed by the old one still
  // verify. Dropping them would sign every user out at once.
  if (addIdx !== -1) {
    const current = process.env.JWT_SIGNING_KEYS?.trim()
    if (!current) {
      console.error(
        'JWT_SIGNING_KEYS is not set in this shell, so there is nothing to add to.\n' +
          'Run without --add for a first key, or export the current value first.',
      )
      process.exitCode = 1
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(current)
    } catch {
      console.error('The current JWT_SIGNING_KEYS is not valid JSON — fix it before rotating.')
      process.exitCode = 1
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.error('The current JWT_SIGNING_KEYS is not a JSON object keyed by kid.')
      process.exitCode = 1
      return
    }
    Object.assign(keys, parsed)
    if (keys[kid]) {
      console.error(`kid "${kid}" already exists. Pick an unused one.`)
      process.exitCode = 1
      return
    }
  }

  keys[kid] = await newKeyBase64()

  console.log(`JWT_SIGNING_KEYS=${JSON.stringify(keys)}`)
  console.log(`JWT_CURRENT_KID=${kid}`)
  if (addIdx !== -1) {
    console.log(
      '\n# Both keys are live: the new one signs, the old one still verifies.\n' +
        '# Remove the old kid only after every token signed with it has expired\n' +
        '# (REFRESH_TOKEN_TTL_S — 30 days by default).',
    )
  }
}

void main()
