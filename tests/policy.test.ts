import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getChainIdFromSignatureTuples,
  parseTransaction,
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
  TOKEN,
} from './fixtures.js'

test('accepts only the expected sender-only Kairos JPYC transfer', () => {
  const validated = validateSenderTransaction(SENDER_RAW, TOKEN, 150000n)

  assert.equal(validated.sender.toLowerCase(), '0xa2a8854b1802d8cd5de631e690817c253d6a9153')
  assert.equal(validated.tokenContract, TOKEN)
  assert.equal(validated.gasLimit, 100000n)
})

test('rejects malformed, wrong-token, and excessive-gas transactions', () => {
  assert.throws(
    () => validateSenderTransaction('0x31', TOKEN, 150000n),
    TransactionPolicyError,
  )
  assert.throws(
    () => validateSenderTransaction(SENDER_RAW, OTHER_ADDRESS, 150000n),
    TransactionPolicyError,
  )
  assert.throws(
    () => validateSenderTransaction(SENDER_RAW, TOKEN, 99999n),
    TransactionPolicyError,
  )
})

test('offline fee-payer signing preserves sender fields and adds one Kairos signature', async () => {
  const sender = validateSenderTransaction(SENDER_RAW, TOKEN, 150000n)
  const fixture = await feePayerFixture()
  const fullRaw = validateFeePayerTransaction(
    fixture.fullRaw,
    sender,
    fixture.address,
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
