import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createWalletClient,
  custom,
  getChainIdFromSignatureTuples,
  kaia,
  parseTransaction,
  privateKeyToAccount,
  TxType,
} from '@kaiachain/viem-ext'
import {
  TransactionPolicyError,
  validateFeePayerTransaction,
  validateSenderTransaction,
} from '../src/policy.js'
import {
  feePayerFixture,
  OTHER_ADDRESS,
  SENDER_RAW,
  TEST_PRIVATE_KEY,
  TOKEN,
} from './fixtures.js'

test('accepts only the expected sender-only Kairos JPYC transfer', () => {
  const validated = validateSenderTransaction(SENDER_RAW, TOKEN, 150000n, 1001)

  assert.equal(validated.sender.toLowerCase(), '0xa2a8854b1802d8cd5de631e690817c253d6a9153')
  assert.equal(validated.tokenContract, TOKEN)
  assert.equal(validated.gasLimit, 100000n)
})

test('rejects malformed, wrong-token, and excessive-gas transactions', () => {
  assert.throws(
    () => validateSenderTransaction('0x31', TOKEN, 150000n, 1001),
    TransactionPolicyError,
  )
  assert.throws(
    () => validateSenderTransaction(SENDER_RAW, OTHER_ADDRESS, 150000n, 1001),
    TransactionPolicyError,
  )
  assert.throws(
    () => validateSenderTransaction(SENDER_RAW, TOKEN, 99999n, 1001),
    TransactionPolicyError,
  )
})

test('offline fee-payer signing preserves sender fields and adds one Kairos signature', async () => {
  const sender = validateSenderTransaction(SENDER_RAW, TOKEN, 150000n, 1001)
  const fixture = await feePayerFixture()
  const fullRaw = validateFeePayerTransaction(
    fixture.fullRaw,
    sender,
    fixture.address,
    1001,
  )
  const parsed = parseTransaction(fullRaw)

  assert.equal(parsed.type, TxType.FeeDelegatedSmartContractExecution)
  assert.equal(parsed.feePayer?.toLowerCase(), fixture.address.toLowerCase())
  assert.equal(parsed.from?.toLowerCase(), sender.sender.toLowerCase())
  assert.equal(parsed.to?.toLowerCase(), TOKEN.toLowerCase())
  assert.deepEqual(parsed.txSignatures, sender.transaction.txSignatures)
  assert.equal(parsed.feePayerSignatures?.length, 1)
  assert.equal(
    getChainIdFromSignatureTuples(parsed.feePayerSignatures ?? []),
    1001,
  )
})

test('accepts the sender-only transaction shape produced by the current Mainnet wallet serializer', async () => {
  const account = privateKeyToAccount(TEST_PRIVATE_KEY)

  const mainnet = kaia

  const wallet = createWalletClient({
    account,
    chain: mainnet,
    transport: custom({
      async request({ method }) {
        if (method === 'eth_chainId') return '0x2019'
        throw new Error(`Unexpected offline RPC method: ${method}`)
      },
    }),
  })

  const raw = await wallet.signTransaction({
    type: TxType.FeeDelegatedSmartContractExecution,
    chainId: 8217,
    nonce: 0,
    gasPrice: 25_000_000_000n,
    gasLimit: 70_000n,
    from: account.address,
    to: TOKEN,
    value: 0n,
    data:
      '0xa9059cbb' +
      '00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8' +
      '0000000000000000000000000000000000000000000000000de0b6b3a7640000',
  })

  const parsed = parseTransaction(raw)

  assert.equal(parsed.type, '0x31')
  assert.equal(parsed.value, '0x')

  const validated = validateSenderTransaction(raw, TOKEN, 150000n, 8217)

  assert.equal(validated.sender.toLowerCase(), account.address.toLowerCase())
  assert.equal(validated.gasLimit, 70_000n)
  assert.equal(validated.gasPrice, 25_000_000_000n)
  assert.equal(validated.atomicAmount, 1_000_000_000_000_000_000n)
})

test('derives chain policy from the selected profile expectation', () => {
  assert.throws(
    () => validateSenderTransaction(SENDER_RAW, TOKEN, 150000n, 8217),
    (error: unknown) =>
      error instanceof TransactionPolicyError && error.code === 'WRONG_CHAIN',
  )
})
