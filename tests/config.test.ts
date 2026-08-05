import assert from 'node:assert/strict'
import test from 'node:test'
import { ConfigurationError, loadConfig } from '../src/config.js'
import { TEST_PRIVATE_KEY, TOKEN } from './fixtures.js'

const validEnvironment = {
  FEE_PAYER_API_KEY: 'a'.repeat(64),
  FEE_PAYER_PRIVATE_KEY: TEST_PRIVATE_KEY,
  KAIROS_RPC_URL: 'https://public-en-kairos.node.kaia.io',
  FEE_PAYER_TOKEN_CONTRACT: TOKEN,
}

test('loads a strict Kairos loopback configuration', () => {
  const config = loadConfig(validEnvironment)

  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 19000)
  assert.equal(config.tokenContract, TOKEN)
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
