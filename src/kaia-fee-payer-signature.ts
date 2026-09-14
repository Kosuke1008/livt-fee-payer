import { KlaytnTxFactory } from '@kaiachain/viem-ext'
import {
  getAddress,
  isAddressEqual,
  keccak256,
  recoverAddress,
  toHex,
  type Address,
  type Hash,
  type Hex,
} from 'viem'

const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n

export interface KaiaFeePayerSigningPayload {
  readonly digest: Hash
  readonly signingRlp: Hex
}

export interface ParsedExternalSignature {
  readonly r: Hex
  readonly s: Hex
  readonly yParity: 0 | 1
  readonly wasHighS: boolean
}

export function feePayerSigningPayload(
  senderRaw: Hex,
  feePayer: Address,
  chainId: number,
): KaiaFeePayerSigningPayload {
  const senderTransaction = KlaytnTxFactory.fromRLP(senderRaw)
  const transaction = KlaytnTxFactory.fromObject({
    ...senderTransaction.toObject(),
    chainId,
    feePayer,
  })
  const signingRlp = transaction.sigFeePayerRLP() as Hex
  return { signingRlp, digest: keccak256(signingRlp) }
}

export async function finalizeFeePayerSignature(options: {
  readonly senderRaw: Hex
  readonly feePayer: Address
  readonly chainId: number
  readonly derSignature: Uint8Array
}): Promise<{ readonly signedRaw: Hex; readonly signature: ParsedExternalSignature }> {
  const payload = feePayerSigningPayload(
    options.senderRaw,
    options.feePayer,
    options.chainId,
  )
  const parsed = parseDerSignature(options.derSignature)
  const sValue = parsed.s > SECP256K1_HALF_ORDER
    ? SECP256K1_ORDER - parsed.s
    : parsed.s
  const r = scalarHex(parsed.r)
  const s = scalarHex(sValue)

  let yParity: 0 | 1 | null = null
  for (const candidate of [0, 1] as const) {
    try {
      const recovered = await recoverAddress({
        hash: payload.digest,
        signature: { r, s, yParity: candidate },
      })
      if (isAddressEqual(recovered, options.feePayer)) yParity = candidate
    } catch {
      // Both recovery candidates are tested; malformed points fail closed below.
    }
  }
  if (yParity === null) throw new InvalidExternalSignatureError()

  const senderTransaction = KlaytnTxFactory.fromRLP(options.senderRaw)
  const transaction = KlaytnTxFactory.fromObject({
    ...senderTransaction.toObject(),
    chainId: options.chainId,
    feePayer: options.feePayer,
  })
  transaction.addFeePayerSig({
    r,
    s,
    v: yParity + options.chainId * 2 + 35,
  })
  return {
    signedRaw: transaction.txHashRLP() as Hex,
    signature: { r, s, yParity, wasHighS: parsed.s > SECP256K1_HALF_ORDER },
  }
}

export class InvalidExternalSignatureError extends Error {
  override readonly name = 'InvalidExternalSignatureError'

  constructor() {
    super('External signer returned an invalid signature')
  }
}

function parseDerSignature(signature: Uint8Array): {
  readonly r: bigint
  readonly s: bigint
} {
  const bytes = Buffer.from(signature)
  if (bytes.length < 8 || bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2) {
    throw new InvalidExternalSignatureError()
  }
  let offset = 2
  const r = readDerInteger(bytes, offset)
  offset = r.nextOffset
  const s = readDerInteger(bytes, offset)
  if (s.nextOffset !== bytes.length) throw new InvalidExternalSignatureError()
  if (
    r.value <= 0n ||
    s.value <= 0n ||
    r.value >= SECP256K1_ORDER ||
    s.value >= SECP256K1_ORDER
  ) {
    throw new InvalidExternalSignatureError()
  }
  return { r: r.value, s: s.value }
}

function readDerInteger(
  bytes: Buffer,
  offset: number,
): { readonly value: bigint; readonly nextOffset: number } {
  if (bytes[offset] !== 0x02) throw new InvalidExternalSignatureError()
  const length = bytes[offset + 1]
  if (length === undefined || length === 0 || length > 33) {
    throw new InvalidExternalSignatureError()
  }
  const start = offset + 2
  const end = start + length
  const valueBytes = bytes.subarray(start, end)
  if (
    end > bytes.length ||
    (valueBytes[0] ?? 0) >= 0x80 ||
    (length > 1 && valueBytes[0] === 0 && (valueBytes[1] ?? 0) < 0x80)
  ) {
    throw new InvalidExternalSignatureError()
  }
  return {
    value: BigInt(`0x${valueBytes.toString('hex')}`),
    nextOffset: end,
  }
}

function scalarHex(value: bigint): Hex {
  return toHex(value, { size: 32 })
}

export function normalizeAddress(address: Address): Address {
  return getAddress(address)
}
