import assert from 'node:assert/strict'
import test from 'node:test'
import type { Address } from 'viem'
import { inspectMainnetPilotPolicy } from '../src/pilot-policy.js'

const feePayer = '0x1111111111111111111111111111111111111111' as Address
const valid = {
  SELF_HOSTED_MAINNET_MAX_PAYMENT_JPYC: '1',
  SELF_HOSTED_MAINNET_MAX_GAS: '150000',
  SELF_HOSTED_MAINNET_MAX_GAS_PRICE_WEI: '25000000000',
  SELF_HOSTED_MAINNET_RATE_WINDOW_SECONDS: '3600',
  SELF_HOSTED_MAINNET_MAX_ATTEMPTS_PER_USER: '1',
  SELF_HOSTED_MAINNET_MAX_ATTEMPTS_PER_STORE: '1',
  SELF_HOSTED_MAINNET_MAX_ATTEMPTS_PER_SENDER: '1',
  SELF_HOSTED_MAINNET_MAX_ATTEMPTS_GLOBAL: '1',
  SELF_HOSTED_MAINNET_DAILY_TRANSACTION_LIMIT: '1',
  SELF_HOSTED_MAINNET_DAILY_KAIA_BUDGET: '0.00375',
  MAINNET_PILOT_MAX_FEE_PAYER_BALANCE_KAIA: '0.01375',
  MAINNET_STAGING_MERCHANT_ADDRESS: '0x2222222222222222222222222222222222222222',
  MAINNET_STAGING_APPROVED_SENDER_ADDRESSES: '0x3333333333333333333333333333333333333333',
}

const authorizationKey = 'c'.repeat(64)

test('reports exact public pilot policy without floating point conversion', () => {
  const result = inspectMainnetPilotPolicy({
    ...valid,
    SELF_HOSTED_MAINNET_MAX_PAYMENT_JPYC: '100000',
  }, 150000n, 10n ** 16n, feePayer, authorizationKey)
  assert.equal(result.ready, true)
  assert.equal(result.max_payment_jpyc, '100000')
  assert.equal(result.daily_kaia_budget_wei, '3750000000000000')
  assert.equal(result.minimum_reserve_wei, '10000000000000000')
  assert.equal(result.maximum_balance_wei, '13750000000000000')
  assert.equal(result.authorization_key_id, 'sha256:c2f480d4dda9f452')
  assert.equal(result.authorization_mode, 'hmac-sha256-v1')
  assert.deepEqual(result.diagnostics, [])
})

test('requires maximum balance to preserve reserve after the full daily budget', () => {
  const tenPayments = {
    ...valid,
    SELF_HOSTED_MAINNET_MAX_ATTEMPTS_PER_USER: '10',
    SELF_HOSTED_MAINNET_MAX_ATTEMPTS_PER_STORE: '10',
    SELF_HOSTED_MAINNET_MAX_ATTEMPTS_PER_SENDER: '10',
    SELF_HOSTED_MAINNET_MAX_ATTEMPTS_GLOBAL: '10',
    SELF_HOSTED_MAINNET_DAILY_TRANSACTION_LIMIT: '10',
    SELF_HOSTED_MAINNET_DAILY_KAIA_BUDGET: '0.0375',
    MAINNET_PILOT_MAX_FEE_PAYER_BALANCE_KAIA: '0.0475',
  }
  assert.equal(inspectMainnetPilotPolicy(
    tenPayments,
    150000n,
    10n ** 16n,
    feePayer,
    authorizationKey,
  ).ready, true)

  const insufficientMaximum = inspectMainnetPilotPolicy({
    ...tenPayments,
    MAINNET_PILOT_MAX_FEE_PAYER_BALANCE_KAIA: '0.047499999999999999',
  }, 150000n, 10n ** 16n, feePayer, authorizationKey)
  assert.equal(insufficientMaximum.ready, false)
  assert.ok(insufficientMaximum.diagnostics.includes(
    'MAXIMUM_BALANCE_BELOW_DAILY_BUDGET_PLUS_RESERVE',
  ))
})

test('fails closed for missing policy and each conservative bound', () => {
  for (const environment of [
    {},
    { ...valid, SELF_HOSTED_MAINNET_MAX_ATTEMPTS_GLOBAL: '1001' },
    {
      ...valid,
      SELF_HOSTED_MAINNET_MAX_ATTEMPTS_PER_USER: '2',
      SELF_HOSTED_MAINNET_MAX_ATTEMPTS_GLOBAL: '1',
    },
    { ...valid, SELF_HOSTED_MAINNET_MAX_PAYMENT_JPYC: '100001' },
    { ...valid, SELF_HOSTED_MAINNET_MAX_GAS: '1000001' },
    { ...valid, SELF_HOSTED_MAINNET_RATE_WINDOW_SECONDS: '3599' },
    { ...valid, SELF_HOSTED_MAINNET_DAILY_KAIA_BUDGET: '0.1' },
    { ...valid, MAINNET_PILOT_MAX_FEE_PAYER_BALANCE_KAIA: '0.01' },
    { ...valid, MAINNET_STAGING_APPROVED_SENDER_ADDRESSES: valid.MAINNET_STAGING_MERCHANT_ADDRESS },
  ]) {
    assert.equal(inspectMainnetPilotPolicy(
      environment,
      150000n,
      10n ** 16n,
      feePayer,
      authorizationKey,
    ).ready, false)
  }
})
