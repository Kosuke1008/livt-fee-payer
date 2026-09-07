import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../src/config.js'
import {
  createFeePayerSigner,
  LocalPrivateKeyFeePayerSigner,
  SignerUnavailableError,
} from '../src/signer.js'
import { TEST_PRIVATE_KEY } from './fixtures.js'

test('Kairos local signer is isolated behind FeePayerSigner', () => {
  const config = loadConfig({
    BLOCKCHAIN_NETWORK: 'kairos',
    FEE_PAYER_API_KEY: 'a'.repeat(64),
    FEE_PAYER_KAIROS_PRIVATE_KEY: TEST_PRIVATE_KEY,
    FEE_PAYER_KAIROS_RPC_URL: 'https://kairos.example.test',
    FEE_PAYER_KILL_SWITCH: 'false',
  })

  const signer = createFeePayerSigner(config)

  assert.ok(signer instanceof LocalPrivateKeyFeePayerSigner)
  assert.match(signer.address, /^0x[0-9a-fA-F]{40}$/u)
})

test('Mainnet signer remains unavailable without exposing key material', async () => {
  const privateValue = `0x${'ab'.repeat(32)}`

  assert.throws(
    () =>
      loadConfig({
        BLOCKCHAIN_NETWORK: 'kaia-mainnet',
        FEE_PAYER_API_KEY: 'a'.repeat(64),
        FEE_PAYER_KAIA_MAINNET_RPC_URL: 'https://mainnet.example.test',
        FEE_PAYER_KAIA_MAINNET_ADDRESS:
          '0x1111111111111111111111111111111111111111',
        FEE_PAYER_KAIROS_ADDRESS:
          '0x2222222222222222222222222222222222222222',
        FEE_PAYER_MAINNET_SIGNER_TYPE: 'external',
        FEE_PAYER_MIN_RESERVE_KAIA: '0.1',
        FEE_PAYER_KAIA_MAINNET_PRIVATE_KEY: privateValue,
      }),
    (error: unknown) =>
      error instanceof Error && !error.message.includes(privateValue),
  )

  const config = loadConfig({
    BLOCKCHAIN_NETWORK: 'kaia-mainnet',
    FEE_PAYER_API_KEY: 'a'.repeat(64),
    FEE_PAYER_KAIA_MAINNET_RPC_URL: 'https://mainnet.example.test',
    FEE_PAYER_KAIA_MAINNET_ADDRESS:
      '0x1111111111111111111111111111111111111111',
    FEE_PAYER_KAIROS_ADDRESS:
      '0x2222222222222222222222222222222222222222',
    FEE_PAYER_MAINNET_SIGNER_TYPE: 'external',
    FEE_PAYER_MIN_RESERVE_KAIA: '0.1',
  })

  const signer = createFeePayerSigner(config)
  assert.deepEqual(await signer.health(), {
    status: 'unavailable',
    address: config.feePayerAddress,
  })
  await assert.rejects(
    () => signer.signAsFeePayer({ senderRaw: '0x31' }),
    SignerUnavailableError,
  )
})

test('Mainnet and Kairos identities must be explicitly separated', () => {
  const shared = '0x1111111111111111111111111111111111111111'
  const environment = {
    BLOCKCHAIN_NETWORK: 'kaia-mainnet',
    FEE_PAYER_API_KEY: 'a'.repeat(64),
    FEE_PAYER_KAIA_MAINNET_RPC_URL: 'https://mainnet.example.test',
    FEE_PAYER_KAIA_MAINNET_ADDRESS: shared,
    FEE_PAYER_KAIROS_ADDRESS: shared,
    FEE_PAYER_MAINNET_SIGNER_TYPE: 'external',
    FEE_PAYER_MIN_RESERVE_KAIA: '0.1',
  }

  assert.throws(() => loadConfig(environment))
  assert.doesNotThrow(() =>
    loadConfig({
      ...environment,
      FEE_PAYER_ALLOW_CROSS_NETWORK_IDENTITY: 'true',
    }),
  )
})
