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
  readonly broadcastFailure?: Error
  readonly receiptStatus?: 'success' | 'reverted'
  readonly balance?: bigint
  readonly balanceFailure?: boolean
} = {}): Promise<{
  readonly value: SponsorDependencies
  readonly calls: Record<
    'balance' | 'sign' | 'recover' | 'broadcast' | 'receipt',
    number
  >
  readonly expectedHash: Hash
}> {
  const fixture = await feePayerFixture()
  const expectedHash = keccak256(fixture.fullRaw)
  const calls = { balance: 0, sign: 0, recover: 0, broadcast: 0, receipt: 0 }
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
        if (options.broadcastFailure !== undefined) {
          throw options.broadcastFailure
        }
        return expectedHash
      },
      waitForReceipt: async () => {
        calls.receipt++
        return {
          transactionHash: expectedHash,
          status: options.receiptStatus ?? 'success',
        }
      },
      getFeePayerBalance: async () => {
        calls.balance++
        if (options.balanceFailure === true) throw new Error('private RPC')
        return options.balance ?? 10n ** 18n
      },
    },
  }
}

test('signs, recovers, broadcasts once, and reuses a successful result', async () => {
  const fixture = await dependencies()
  const service = new SponsorService(
    {
      tokenContract: TOKEN,
      maxGas: 150000n,
      chainId: 1001,
      killSwitchActive: false,
      minimumReserveWei: 0n,
    },
    fixture.value,
  )

  const first = await service.sponsor(SENDER_RAW)
  const second = await service.sponsor(SENDER_RAW)

  assert.deepEqual(first, { hash: fixture.expectedHash, status: 'success' })
  assert.deepEqual(second, first)
  assert.deepEqual(fixture.calls, {
    balance: 1,
    sign: 1,
    recover: 1,
    broadcast: 1,
    receipt: 1,
  })
})

test('never broadcasts when recovered sender does not match', async () => {
  const fixture = await dependencies({ recovered: OTHER_ADDRESS })
  const service = new SponsorService(
    {
      tokenContract: TOKEN,
      maxGas: 150000n,
      chainId: 1001,
      killSwitchActive: false,
      minimumReserveWei: 0n,
    },
    fixture.value,
  )

  await assert.rejects(() => service.sponsor(SENDER_RAW), TransactionPolicyError)
  assert.equal(fixture.calls.broadcast, 0)
})

for (const [caseName, failure] of [
  ['timeout', new Error('request timed out')],
  ['connection reset', new Error('connection reset')],
  ['ambiguous RPC response', new Error('private RPC ambiguity')],
] as const) {
  test(`does not automatically retry a broadcast ${caseName}`, async () => {
    const fixture = await dependencies({ broadcastFailure: failure })
    const service = new SponsorService(
      {
        tokenContract: TOKEN,
        maxGas: 150000n,
        chainId: 1001,
        killSwitchActive: false,
        minimumReserveWei: 0n,
      },
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
}

test('kill switch and insufficient reserve block signing and broadcast', async () => {
  for (const [killSwitchActive, balance] of [
    [true, 10n ** 18n],
    [false, 1n],
  ] as const) {
    const fixture = await dependencies({ balance })
    const service = new SponsorService(
      {
        tokenContract: TOKEN,
        maxGas: 150000n,
        chainId: 1001,
        killSwitchActive,
        minimumReserveWei: 10n,
      },
      fixture.value,
    )

    await assert.rejects(() => service.sponsor(SENDER_RAW))
    assert.equal(fixture.calls.sign, 0)
    assert.equal(fixture.calls.broadcast, 0)
  }
})

test('balance RPC failure fails safely before signing', async () => {
  const fixture = await dependencies({ balanceFailure: true })
  const service = new SponsorService(
    {
      tokenContract: TOKEN,
      maxGas: 150000n,
      chainId: 1001,
      killSwitchActive: false,
      minimumReserveWei: 10n,
    },
    fixture.value,
  )

  await assert.rejects(() => service.sponsor(SENDER_RAW))
  assert.equal(fixture.calls.sign, 0)
  assert.equal(fixture.calls.broadcast, 0)
})

test('a confirmed revert is retained and cannot be broadcast again', async () => {
  const fixture = await dependencies({ receiptStatus: 'reverted' })
  const service = new SponsorService(
    {
      tokenContract: TOKEN,
      maxGas: 150000n,
      chainId: 1001,
      killSwitchActive: false,
      minimumReserveWei: 0n,
    },
    fixture.value,
  )

  assert.equal((await service.sponsor(SENDER_RAW)).status, 'reverted')
  assert.equal((await service.sponsor(SENDER_RAW)).status, 'reverted')
  assert.equal(fixture.calls.broadcast, 1)
})
