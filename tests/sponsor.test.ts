import assert from 'node:assert/strict'
import test from 'node:test'
import { keccak256, type Address, type Hash, type Hex } from 'viem'
import {
  SponsorService,
  SponsorshipStatusUnknownError,
  type SponsorDependencies,
} from '../src/sponsor.js'
import { TransactionPolicyError } from '../src/policy.js'
import {
  feePayerFixture,
  OTHER_ADDRESS,
  SENDER,
  SENDER_RAW,
  TOKEN,
} from './fixtures.js'

async function dependencies(options: {
  readonly recovered?: Address
  readonly broadcastFailure?: boolean
  readonly receiptStatus?: 'success' | 'reverted'
} = {}): Promise<{
  readonly value: SponsorDependencies
  readonly calls: Record<'sign' | 'recover' | 'broadcast' | 'receipt', number>
  readonly expectedHash: Hash
}> {
  const fixture = await feePayerFixture()
  const expectedHash = keccak256(fixture.fullRaw)
  const calls = { sign: 0, recover: 0, broadcast: 0, receipt: 0 }
  return {
    calls,
    expectedHash,
    value: {
      feePayerAddress: fixture.address,
      signAsFeePayer: async (): Promise<Hex> => {
        calls.sign++
        return fixture.fullRaw
      },
      recoverSender: async () => {
        calls.recover++
        return options.recovered ?? SENDER
      },
      broadcast: async () => {
        calls.broadcast++
        if (options.broadcastFailure === true) throw new Error('private RPC')
        return expectedHash
      },
      waitForReceipt: async () => {
        calls.receipt++
        return {
          transactionHash: expectedHash,
          status: options.receiptStatus ?? 'success',
        }
      },
    },
  }
}

test('signs, recovers, broadcasts once, and reuses a successful result', async () => {
  const fixture = await dependencies()
  const service = new SponsorService(
    { tokenContract: TOKEN, maxGas: 150000n },
    fixture.value,
  )

  const first = await service.sponsor(SENDER_RAW)
  const second = await service.sponsor(SENDER_RAW)

  assert.deepEqual(first, { hash: fixture.expectedHash, status: 'success' })
  assert.deepEqual(second, first)
  assert.deepEqual(fixture.calls, {
    sign: 1,
    recover: 1,
    broadcast: 1,
    receipt: 1,
  })
})

test('never broadcasts when recovered sender does not match', async () => {
  const fixture = await dependencies({ recovered: OTHER_ADDRESS })
  const service = new SponsorService(
    { tokenContract: TOKEN, maxGas: 150000n },
    fixture.value,
  )

  await assert.rejects(() => service.sponsor(SENDER_RAW), TransactionPolicyError)
  assert.equal(fixture.calls.broadcast, 0)
})

test('does not automatically retry an ambiguous broadcast', async () => {
  const fixture = await dependencies({ broadcastFailure: true })
  const service = new SponsorService(
    { tokenContract: TOKEN, maxGas: 150000n },
    fixture.value,
  )

  await assert.rejects(() => service.sponsor(SENDER_RAW), (error: unknown) => {
    assert.ok(error instanceof SponsorshipStatusUnknownError)
    assert.equal(error.stage, 'broadcast')
    return true
  })
  await assert.rejects(
    () => service.sponsor(SENDER_RAW),
    SponsorshipStatusUnknownError,
  )
  assert.equal(fixture.calls.broadcast, 1)
})

test('a confirmed revert can be attempted again', async () => {
  const fixture = await dependencies({ receiptStatus: 'reverted' })
  const service = new SponsorService(
    { tokenContract: TOKEN, maxGas: 150000n },
    fixture.value,
  )

  assert.equal((await service.sponsor(SENDER_RAW)).status, 'reverted')
  assert.equal((await service.sponsor(SENDER_RAW)).status, 'reverted')
  assert.equal(fixture.calls.broadcast, 2)
})
