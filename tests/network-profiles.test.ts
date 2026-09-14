import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NetworkExecutionDisabledError,
  NetworkProfileError,
  assertFeePayerExecutionAllowed,
  resolveNetworkProfile,
} from '../src/network-profiles.js'
import { shouldUseDevelopmentReadinessBypass } from '../src/readiness.js'
import { TOKEN } from './fixtures.js'

test('resolves the approved Kairos profile and existing execution path', () => {
  const profile = resolveNetworkProfile({
    BLOCKCHAIN_NETWORK: 'kairos',
    FEE_PAYER_KAIROS_RPC_URL: 'https://kairos.example.test',
  })

  assert.equal(profile.id, 'kairos')
  assert.equal(profile.chainId, 1001)
  assert.equal(profile.jpyc.contract.toLowerCase(), TOKEN.toLowerCase())
  assert.equal(profile.jpyc.decimals, 18)
  assert.doesNotThrow(() => assertFeePayerExecutionAllowed(profile))
})

test('resolves Mainnet metadata but never enables Phase 1 execution', () => {
  const profile = resolveNetworkProfile({
    BLOCKCHAIN_NETWORK: 'kaia-mainnet',
    FEE_PAYER_KAIA_MAINNET_RPC_URL: 'https://mainnet.example.test',
    FEE_PAYER_MAINNET_ENABLED: 'true',
  })

  assert.equal(profile.chainId, 8217)
  assert.equal(profile.executionEnabled, false)
  assert.equal(profile.signingEnabled, false)
  assert.equal(profile.broadcastEnabled, false)
  assert.throws(
    () => assertFeePayerExecutionAllowed(profile),
    NetworkExecutionDisabledError,
  )
})

test('Mainnet execution requires the reviewed release capability', () => {
  const profile = resolveNetworkProfile({
    BLOCKCHAIN_NETWORK: 'kaia-mainnet',
    FEE_PAYER_KAIA_MAINNET_RPC_URL: 'https://mainnet.example.test',
  }, true)
  assert.equal(profile.executionEnabled, true)
  assert.equal(profile.signingEnabled, true)
  assert.equal(profile.broadcastEnabled, true)
})

test('rejects public or duplicated Mainnet RPC providers', () => {
  for (const rpcUrl of [
    'https://public-en.node.kaia.io',
    'https://public-en-kairos.node.kaia.io',
  ]) {
    assert.throws(
      () =>
        resolveNetworkProfile({
          BLOCKCHAIN_NETWORK: 'kaia-mainnet',
          FEE_PAYER_KAIA_MAINNET_RPC_URL: rpcUrl,
        }),
      NetworkProfileError,
    )
  }
  assert.throws(
    () =>
      resolveNetworkProfile({
        BLOCKCHAIN_NETWORK: 'kaia-mainnet',
        FEE_PAYER_KAIA_MAINNET_RPC_URL: 'https://mainnet.example.test',
        FEE_PAYER_KAIA_MAINNET_SECONDARY_RPC_URL:
          'https://mainnet.example.test',
      }),
    NetworkProfileError,
  )
})

test('rejects missing, malformed, and unsupported network selectors', () => {
  for (const network of [undefined, '', 'KAIROS', 'mainnet', '8217']) {
    assert.throws(
      () =>
        resolveNetworkProfile({
          BLOCKCHAIN_NETWORK: network,
          FEE_PAYER_KAIROS_RPC_URL: 'https://kairos.example.test',
        }),
      NetworkProfileError,
    )
  }
})

test('rejects missing RPC, wrong chain ID, and wrong token overrides', () => {
  assert.throws(
    () => resolveNetworkProfile({ BLOCKCHAIN_NETWORK: 'kaia-mainnet' }),
    NetworkProfileError,
  )
  assert.throws(
    () =>
      resolveNetworkProfile({
        BLOCKCHAIN_NETWORK: 'kairos',
        FEE_PAYER_KAIROS_RPC_URL: 'https://kairos.example.test',
        FEE_PAYER_CHAIN_ID: '8217',
      }),
    NetworkProfileError,
  )
  assert.throws(
    () =>
      resolveNetworkProfile({
        BLOCKCHAIN_NETWORK: 'kairos',
        FEE_PAYER_KAIROS_RPC_URL: 'https://kairos.example.test',
        FEE_PAYER_TOKEN_CONTRACT: '0x1111111111111111111111111111111111111111',
      }),
    NetworkProfileError,
  )
})

test('APP_ENV and NODE_ENV never select a blockchain network', () => {
  const profile = resolveNetworkProfile({
    BLOCKCHAIN_NETWORK: 'kairos',
    FEE_PAYER_KAIROS_RPC_URL: 'https://kairos.example.test',
    APP_ENV: 'production',
    NODE_ENV: 'production',
  })

  assert.equal(profile.id, 'kairos')
})

test('development bypass is explicit and can never apply to Mainnet', () => {
  const kairos = resolveNetworkProfile({
    BLOCKCHAIN_NETWORK: 'kairos',
    FEE_PAYER_KAIROS_RPC_URL: 'https://kairos.example.test',
  })
  const mainnet = resolveNetworkProfile({
    BLOCKCHAIN_NETWORK: 'kaia-mainnet',
    FEE_PAYER_KAIA_MAINNET_RPC_URL: 'https://mainnet.example.test',
  })

  assert.equal(
    shouldUseDevelopmentReadinessBypass(kairos, {
      FEE_PAYER_SKIP_KAIROS_CHECK: '1',
      FEE_PAYER_DEVELOPMENT_BYPASS_ENABLED: '1',
      NODE_ENV: 'development',
    }),
    true,
  )
  assert.throws(
    () =>
      shouldUseDevelopmentReadinessBypass(mainnet, {
        FEE_PAYER_SKIP_KAIROS_CHECK: '1',
        FEE_PAYER_DEVELOPMENT_BYPASS_ENABLED: '1',
        NODE_ENV: 'development',
      }),
    NetworkProfileError,
  )
  assert.throws(
    () =>
      shouldUseDevelopmentReadinessBypass(kairos, {
        FEE_PAYER_SKIP_KAIROS_CHECK: '1',
        FEE_PAYER_DEVELOPMENT_BYPASS_ENABLED: '1',
        NODE_ENV: 'production',
      }),
    NetworkProfileError,
  )
})
