import assert from 'node:assert/strict'
import test from 'node:test'
import { KlaytnTxFactory, privateKeyToAccount } from '@kaiachain/viem-ext'
import { parseSignature, type Hash, type Hex } from 'viem'
import { loadConfig } from '../src/config.js'
import {
  AwsKmsFeePayerSigner,
  createFeePayerSigner,
  ExternalSignerError,
  type ExternalSignerKey,
  type ExternalSigningProvider,
  LocalPrivateKeyFeePayerSigner,
} from '../src/signer.js'
import { feePayerSigningPayload } from '../src/kaia-fee-payer-signature.js'
import { SENDER_RAW, TEST_PRIVATE_KEY } from './fixtures.js'

const account = privateKeyToAccount(TEST_PRIVATE_KEY)
const CURVE_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

const mainnetEnvironment = {
  BLOCKCHAIN_NETWORK: 'kaia-mainnet',
  FEE_PAYER_API_KEY: 'a'.repeat(64),
  MAINNET_PAYMENT_AUTHORIZATION_KEY: 'c'.repeat(64),
  FEE_PAYER_KAIA_MAINNET_RPC_URL: 'https://mainnet.example.test',
  FEE_PAYER_KAIA_MAINNET_ADDRESS: account.address,
  FEE_PAYER_KAIROS_ADDRESS: '0x2222222222222222222222222222222222222222',
  FEE_PAYER_MAINNET_SIGNER_TYPE: 'external',
  FEE_PAYER_MAINNET_SIGNER_BACKEND: 'aws-kms',
  FEE_PAYER_AWS_REGION: 'ap-northeast-1',
  FEE_PAYER_AWS_KMS_KEY_ID: 'alias/livt-mainnet-fee-payer',
  FEE_PAYER_MIN_RESERVE_KAIA: '0.1',
}

class FixtureProvider implements ExternalSigningProvider {
  constructor(
    private readonly key: ExternalSignerKey = fixtureKey(),
    private readonly signingKey: Hex = TEST_PRIVATE_KEY,
    private readonly signatureTransform?: (r: bigint, s: bigint) => [bigint, bigint],
  ) {}

  async getKey(): Promise<ExternalSignerKey> {
    return this.key
  }

  async signDigest(digest: Hash): Promise<{ readonly derSignature: Uint8Array }> {
    const signer = privateKeyToAccount(this.signingKey)
    const signature = parseSignature(await signer.sign({ hash: digest }))
    const [r, s] = this.signatureTransform?.(
      BigInt(signature.r),
      BigInt(signature.s),
    ) ?? [BigInt(signature.r), BigInt(signature.s)]
    return { derSignature: encodeDer(r, s) }
  }
}

test('Kairos local signer remains isolated behind FeePayerSigner', async () => {
  const config = loadConfig({
    BLOCKCHAIN_NETWORK: 'kairos',
    FEE_PAYER_API_KEY: 'a'.repeat(64),
    FEE_PAYER_KAIROS_PRIVATE_KEY: TEST_PRIVATE_KEY,
    FEE_PAYER_KAIROS_RPC_URL: 'https://kairos.example.test',
    FEE_PAYER_KILL_SWITCH: 'false',
  })
  const signer = createFeePayerSigner(config)
  assert.ok(signer instanceof LocalPrivateKeyFeePayerSigner)
  assert.equal((await signer.health()).status, 'ready')
})

test('Mainnet selects AWS KMS external signer without a local key', () => {
  const signer = createFeePayerSigner(
    loadConfig(mainnetEnvironment),
    new FixtureProvider(),
  )
  assert.ok(signer instanceof AwsKmsFeePayerSigner)
  assert.equal(signer.type, 'aws-kms')
  assert.match(signer.metadata.keyReference, /^sha256:[0-9a-f]{16}$/u)
})

test('external public key derives and verifies the configured address', async () => {
  const signer = fixtureSigner()
  assert.deepEqual(await signer.health(), {
    status: 'ready',
    address: account.address,
    type: 'aws-kms',
    metadata: signer.metadata,
  })
})

test('address mismatch and invalid key metadata fail readiness closed', async () => {
  const mismatch = new AwsKmsFeePayerSigner(
    '0x1111111111111111111111111111111111111111',
    1001,
    5000,
    new FixtureProvider(),
    'alias/test',
  )
  assert.equal((await mismatch.health()).status, 'key_mismatch')
  await assert.rejects(
    () => mismatch.signAsFeePayer({ senderRaw: SENDER_RAW }),
    (error: unknown) =>
      error instanceof ExternalSignerError && error.code === 'KEY_MISMATCH',
  )

  const invalid = fixtureSigner(new FixtureProvider({
    ...fixtureKey(),
    keySpec: 'ECC_NIST_P256',
  }))
  assert.equal((await invalid.health()).status, 'unavailable')
})

test('external fixture produces the exact local signer golden transaction', async () => {
  const config = loadConfig({
    BLOCKCHAIN_NETWORK: 'kairos',
    FEE_PAYER_API_KEY: 'a'.repeat(64),
    FEE_PAYER_KAIROS_PRIVATE_KEY: TEST_PRIVATE_KEY,
    FEE_PAYER_KAIROS_RPC_URL: 'https://kairos.example.test',
    FEE_PAYER_KILL_SWITCH: 'false',
  })
  const local = await createFeePayerSigner(config).signAsFeePayer({ senderRaw: SENDER_RAW })
  const external = await fixtureSigner().signAsFeePayer({ senderRaw: SENDER_RAW })
  const payload = feePayerSigningPayload(SENDER_RAW, account.address, 1001)

  assert.equal(
    payload.digest,
    '0xee8182dd270e9c8f7cae7685a24ce1a1f5b7f3b97dca194489151b60042f118d',
  )
  assert.equal(external.signedRaw, local.signedRaw)
  assert.equal(
    external.signedRaw,
    '0x31f901230185066720b300830186a094e7c3d8c9a439fede00d2600032d5db0be71c3c298094a2a8854b1802d8cd5de631e690817c253d6a9153b844a9059cbb00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000de0b6b3a7640000f847f8458207f6a052baf55055acf5989c5fcae851e263f7a99bc2403210ebb4e70bcebc7945bed8a0755eadf37734c3f1629836ed938782dd1e40d4ece67910a84c2dafe234fe8c6d941c5a77d9fa7ef466951b2f01f724bca3a5820b63f847f8458207f6a0e5cbe9d746e8cbbb409a785b5437eaccc406de147fd6ad62a80a8a3d6e14b687a03fe10a7d05c5347508fe047ec07bf89a3088fffe0fe82b2319bdb4a464363075',
  )
  const decoded = KlaytnTxFactory.fromRLP(external.signedRaw).toObject()
  assert.deepEqual(decoded.feePayerSignatures, [[
    '0x07f6',
    '0xe5cbe9d746e8cbbb409a785b5437eaccc406de147fd6ad62a80a8a3d6e14b687',
    '0x3fe10a7d05c5347508fe047ec07bf89a3088fffe0fe82b2319bdb4a464363075',
  ]])
})

test('external signer checks the live gate before KMS Sign and again before assembly', async () => {
  for (const blockedAt of [1, 2]) {
    let checks = 0
    let signCalls = 0
    const fixture = new FixtureProvider()
    const provider: ExternalSigningProvider = {
      getKey: () => fixture.getKey(),
      signDigest: async (digest) => {
        signCalls++
        return fixture.signDigest(digest)
      },
    }
    const signer = fixtureSigner(provider)

    await assert.rejects(() => signer.signAsFeePayer({
      senderRaw: SENDER_RAW,
      assertAssemblyAllowed: () => {
        checks++
        if (checks === blockedAt) throw new Error('gate closed')
      },
    }), /gate closed/u)
    assert.equal(checks, blockedAt)
    assert.equal(signCalls, blockedAt === 1 ? 0 : 1)
  }
})

test('malformed and wrong-signer signatures are rejected', async () => {
  const malformed: ExternalSigningProvider = {
    getKey: async () => fixtureKey(),
    signDigest: async () => ({ derSignature: Uint8Array.from([0x30, 0x00]) }),
  }
  await assert.rejects(
    () => fixtureSigner(malformed).signAsFeePayer({ senderRaw: SENDER_RAW }),
    (error: unknown) =>
      error instanceof ExternalSignerError && error.code === 'INVALID_SIGNATURE',
  )

  const wrongKey = `0x${'34'.repeat(32)}` as Hex
  await assert.rejects(
    () => fixtureSigner(new FixtureProvider(fixtureKey(), wrongKey))
      .signAsFeePayer({ senderRaw: SENDER_RAW }),
    (error: unknown) =>
      error instanceof ExternalSignerError && error.code === 'INVALID_SIGNATURE',
  )
})

test('high-s external signatures are normalized to the golden low-s result', async () => {
  const signer = fixtureSigner(new FixtureProvider(
    fixtureKey(),
    TEST_PRIVATE_KEY,
    (r, s) => [r, CURVE_ORDER - s],
  ))
  const normalized = await signer.signAsFeePayer({ senderRaw: SENDER_RAW })
  const regular = await fixtureSigner().signAsFeePayer({ senderRaw: SENDER_RAW })
  assert.equal(normalized.signedRaw, regular.signedRaw)
})

test('external signing timeout is a fixed pre-broadcast error', async () => {
  const provider: ExternalSigningProvider = {
    getKey: async () => fixtureKey(),
    signDigest: async () => { throw namedError('AbortError') },
  }
  await assert.rejects(
    () => fixtureSigner(provider).signAsFeePayer({ senderRaw: SENDER_RAW }),
    (error: unknown) => {
      assert.ok(error instanceof ExternalSignerError)
      assert.equal(error.code, 'SIGNER_TIMEOUT')
      assert.equal(error.message.includes('secret provider detail'), false)
      return true
    },
  )
})

for (const [name, providerError, expected] of [
  ['authentication failure', namedError('AccessDeniedException'), 'authentication_failure'],
  ['provider unavailable', namedError('ThrottlingException'), 'unavailable'],
] as const) {
  test(`${name} fails health closed without exposing provider details`, async () => {
    const provider: ExternalSigningProvider = {
      getKey: async () => { throw providerError },
      signDigest: async () => { throw providerError },
    }
    assert.equal((await fixtureSigner(provider).health()).status, expected)
  })
}

function fixtureSigner(
  provider: ExternalSigningProvider = new FixtureProvider(),
): AwsKmsFeePayerSigner {
  return new AwsKmsFeePayerSigner(
    account.address,
    1001,
    5000,
    provider,
    'alias/test-only',
  )
}

function fixtureKey(): ExternalSignerKey {
  return {
    publicKeyDer: Buffer.concat([
      Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex'),
      Buffer.from(account.publicKey.slice(2), 'hex'),
    ]),
    keySpec: 'ECC_SECG_P256K1',
    keyUsage: 'SIGN_VERIFY',
    signingAlgorithms: ['ECDSA_SHA_256'],
    enabled: true,
    keyState: 'Enabled',
  }
}

function encodeDer(r: bigint, s: bigint): Uint8Array {
  const rBytes = positiveInteger(r)
  const sBytes = positiveInteger(s)
  return Buffer.concat([
    Buffer.from([0x30, rBytes.length + sBytes.length + 4, 0x02, rBytes.length]),
    rBytes,
    Buffer.from([0x02, sBytes.length]),
    sBytes,
  ])
}

function positiveInteger(value: bigint): Buffer {
  let hex = value.toString(16)
  if (hex.length % 2 !== 0) hex = `0${hex}`
  let bytes = Buffer.from(hex, 'hex')
  if ((bytes[0] ?? 0) >= 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes])
  return bytes
}

function namedError(name: string): Error {
  const error = new Error('secret provider detail')
  error.name = name
  return error
}
