import assert from 'node:assert/strict'
import test from 'node:test'
import { ConfigurationError, loadConfig } from '../src/config.js'
import { createFeePayerSigner } from '../src/signer.js'
import { TEST_PRIVATE_KEY, TOKEN } from './fixtures.js'

const validEnvironment = {
  BLOCKCHAIN_NETWORK: 'kairos',
  FEE_PAYER_API_KEY: 'a'.repeat(64),
  FEE_PAYER_PRIVATE_KEY: TEST_PRIVATE_KEY,
  KAIROS_RPC_URL: 'https://public-en-kairos.node.kaia.io',
  FEE_PAYER_TOKEN_CONTRACT: TOKEN,
}

test('loads a strict Kairos loopback configuration', () => {
  const config = loadConfig(validEnvironment)

  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.networkId, 'kairos')
  assert.equal(config.chainId, 1001)
  assert.equal(config.port, 19000)
  assert.equal(config.tokenContract.toLowerCase(), TOKEN.toLowerCase())
  assert.equal(config.maxGas, 150000n)
  assert.equal(config.receiptTimeoutMs, 45000)
})

test('rejects missing secrets without exposing their values', () => {
  assert.throws(
    () => loadConfig({ ...validEnvironment, FEE_PAYER_API_KEY: '' }),
    ConfigurationError,
  )
  assert.throws(
    () => loadConfig({ ...validEnvironment, FEE_PAYER_PRIVATE_KEY: 'secret' }),
    (error) =>
      error instanceof ConfigurationError &&
      !error.message.includes(TEST_PRIVATE_KEY),
  )
})

test('rejects insecure RPC and unsafe numeric configuration', () => {
  for (const environment of [
    { ...validEnvironment, KAIROS_RPC_URL: 'http://rpc.example.test' },
    { ...validEnvironment, KAIROS_RPC_URL: 'https://user:pass@rpc.test' },
    { ...validEnvironment, FEE_PAYER_PORT: '80' },
    { ...validEnvironment, FEE_PAYER_RECEIPT_TIMEOUT_MS: '60000' },
    { ...validEnvironment, FEE_PAYER_MAX_GAS: '0' },
  ]) {
    assert.throws(() => loadConfig(environment), ConfigurationError)
  }
})

test('loads Mainnet metadata without accepting a process private key', async () => {
  const config = loadConfig({
    BLOCKCHAIN_NETWORK: 'kaia-mainnet',
    FEE_PAYER_API_KEY: 'a'.repeat(64),
    MAINNET_PAYMENT_AUTHORIZATION_KEY: 'c'.repeat(64),
    FEE_PAYER_KAIA_MAINNET_RPC_URL: 'https://mainnet.example.test',
    FEE_PAYER_KAIA_MAINNET_ADDRESS: '0x1111111111111111111111111111111111111111',
    FEE_PAYER_KAIROS_ADDRESS: '0x2222222222222222222222222222222222222222',
    FEE_PAYER_MAINNET_SIGNER_TYPE: 'external',
    FEE_PAYER_MAINNET_SIGNER_BACKEND: 'aws-kms',
    FEE_PAYER_AWS_REGION: 'ap-northeast-1',
    FEE_PAYER_AWS_KMS_KEY_ID: 'alias/livt-mainnet-fee-payer',
    FEE_PAYER_MIN_RESERVE_KAIA: '0.1',
    FEE_PAYER_MAINNET_ENABLED: 'true',
  })

  assert.equal(config.networkId, 'kaia-mainnet')
  assert.equal(config.chainId, 8217)
  assert.equal(config.localPrivateKey, null)
  assert.equal(config.paymentAuthorizationKey, 'c'.repeat(64))
  assert.equal(config.profile.executionEnabled, false)
  assert.equal(createFeePayerSigner(config).type, 'aws-kms')
})

test('rejects incomplete Mainnet external signer configuration', () => {
  const base = {
    BLOCKCHAIN_NETWORK: 'kaia-mainnet',
    FEE_PAYER_API_KEY: 'a'.repeat(64),
    MAINNET_PAYMENT_AUTHORIZATION_KEY: 'c'.repeat(64),
    FEE_PAYER_KAIA_MAINNET_RPC_URL: 'https://mainnet.example.test',
    FEE_PAYER_KAIA_MAINNET_ADDRESS: '0x1111111111111111111111111111111111111111',
    FEE_PAYER_KAIROS_ADDRESS: '0x2222222222222222222222222222222222222222',
    FEE_PAYER_MAINNET_SIGNER_TYPE: 'external',
    FEE_PAYER_MIN_RESERVE_KAIA: '0.1',
  }
  assert.throws(() => loadConfig(base), ConfigurationError)
  assert.throws(() => loadConfig({
    ...base,
    FEE_PAYER_MAINNET_SIGNER_BACKEND: 'aws-kms',
    FEE_PAYER_AWS_REGION: 'ap-northeast-1',
  }), ConfigurationError)
})

test('rejects every process-local key variable under Mainnet', () => {
  const base = {
    BLOCKCHAIN_NETWORK: 'kaia-mainnet',
    FEE_PAYER_API_KEY: 'a'.repeat(64),
    MAINNET_PAYMENT_AUTHORIZATION_KEY: 'c'.repeat(64),
    FEE_PAYER_KAIA_MAINNET_RPC_URL: 'https://mainnet.example.test',
    FEE_PAYER_KAIA_MAINNET_ADDRESS: '0x1111111111111111111111111111111111111111',
    FEE_PAYER_KAIROS_ADDRESS: '0x2222222222222222222222222222222222222222',
    FEE_PAYER_MAINNET_SIGNER_TYPE: 'external',
    FEE_PAYER_MAINNET_SIGNER_BACKEND: 'aws-kms',
    FEE_PAYER_AWS_REGION: 'ap-northeast-1',
    FEE_PAYER_AWS_KMS_KEY_ID: 'alias/livt-mainnet-fee-payer',
    FEE_PAYER_MIN_RESERVE_KAIA: '0.1',
  }
  for (const name of [
    'FEE_PAYER_PRIVATE_KEY',
    'FEE_PAYER_KAIROS_PRIVATE_KEY',
    'FEE_PAYER_KAIA_MAINNET_PRIVATE_KEY',
  ]) {
    assert.throws(() => loadConfig({ ...base, [name]: TEST_PRIVATE_KEY }), ConfigurationError)
  }
})
