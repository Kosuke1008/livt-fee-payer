import assert from 'node:assert/strict'
import test from 'node:test'
import { keccak256, type Address, type Hash, type Hex } from 'viem'
import {
  ServicePolicyError,
  SponsorService,
  SignerOperationError,
  SponsorshipStatusUnknownError,
  type SponsorDependencies,
} from '../src/sponsor.js'
import { ExternalSignerError, SignerTimeoutError } from '../src/signer.js'
import { TransactionPolicyError } from '../src/policy.js'
import type { MainnetPilotPolicy } from '../src/pilot-policy.js'
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
  readonly signingFailure?: Error
  readonly assertSigningAllowed?: () => void
  readonly assertBroadcastAllowed?: () => void
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
        if (options.signingFailure !== undefined) throw options.signingFailure
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
      ...(options.assertSigningAllowed === undefined
        ? {} : { assertSigningAllowed: options.assertSigningAllowed }),
      ...(options.assertBroadcastAllowed === undefined
        ? {} : { assertBroadcastAllowed: options.assertBroadcastAllowed }),
    },
  }
}

function mainnetPilotPolicy(
  overrides: Partial<MainnetPilotPolicy> = {},
): MainnetPilotPolicy {
  return {
    ready: true,
    diagnostics: [],
    max_payment_jpyc: '1',
    max_gas: '150000',
    max_gas_price_wei: '30000000000',
    rate_window_seconds: '86400',
    max_attempts_per_user: '1',
    max_attempts_per_store: '1',
    max_attempts_per_sender: '1',
    max_attempts_global: '1',
    daily_transaction_limit: '1',
    daily_kaia_budget_wei: '4500000000000000',
    minimum_reserve_wei: '10000000000000000',
    maximum_balance_wei: '20000000000000000',
    merchant_address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    sender_address: SENDER.toLowerCase(),
    pilot_payment_id: '1',
    ...overrides,
  }
}

const MAINNET_CONTEXT = {
  paymentId: 1,
  expiresAt: '2099-01-01T00:00:00Z',
} as const

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
    [false, 0n],
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

    await assert.rejects(
      () => service.sponsor(SENDER_RAW),
      (error: unknown) => {
        assert.ok(error instanceof ServicePolicyError)
        assert.equal(
          error.code,
          killSwitchActive
            ? 'KILL_SWITCH_ACTIVE'
            : 'INSUFFICIENT_FEE_PAYER_BALANCE',
        )
        return true
      },
    )
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

for (const [name, failure, code] of [
  ['timeout', new SignerTimeoutError(), 'SIGNER_TIMEOUT'],
  ['authentication failure', new ExternalSignerError('AUTHENTICATION_FAILURE'), 'AUTHENTICATION_FAILURE'],
  ['invalid signature', new ExternalSignerError('INVALID_SIGNATURE'), 'INVALID_SIGNATURE'],
  ['generic signing failure', new Error('provider secret'), 'SIGNING_FAILURE'],
] as const) {
  test(`a pre-broadcast signer ${name} never broadcasts`, async () => {
    const fixture = await dependencies({ signingFailure: failure })
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
      assert.ok(error instanceof SignerOperationError)
      assert.equal(error.code, code)
      return true
    })
    assert.equal(fixture.calls.broadcast, 0)
  })
}

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

test('Mainnet pilot requires exact fee plus reserve before signing', async () => {
  const reserve = 10_000_000_000_000_000n
  const senderGas = 100_000n
  const senderGasPrice = 27_500_000_000n
  const required = reserve + senderGas * senderGasPrice

  for (const [balance, expectedCode] of [
    [required - 1n, 'INSUFFICIENT_FEE_PAYER_BALANCE'],
    [required, null],
  ] as const) {
    const fixture = await dependencies({ balance })
    const service = new SponsorService(
      {
        tokenContract: TOKEN,
        maxGas: 150000n,
        chainId: 1001,
        networkId: 'kaia-mainnet',
        killSwitchActive: false,
        minimumReserveWei: reserve,
        pilotPolicy: mainnetPilotPolicy(),
      },
      fixture.value,
    )

    if (expectedCode === null) {
      assert.equal((await service.sponsor(SENDER_RAW, MAINNET_CONTEXT)).status, 'success')
      assert.equal(fixture.calls.broadcast, 1)
    } else {
      await assert.rejects(() => service.sponsor(SENDER_RAW, MAINNET_CONTEXT), (error: unknown) => {
        assert.ok(error instanceof ServicePolicyError)
        assert.equal(error.code, expectedCode)
        return true
      })
      assert.equal(fixture.calls.sign, 0)
      assert.equal(fixture.calls.broadcast, 0)
    }
  }
})

for (const [name, policy, balance] of [
  ['unready policy', mainnetPilotPolicy({ ready: false }), 15_000_000_000_000_000n],
  ['gas-price cap', mainnetPilotPolicy({ max_gas_price_wei: '27499999999' }), 15_000_000_000_000_000n],
  ['merchant', mainnetPilotPolicy({ merchant_address: OTHER_ADDRESS.toLowerCase() }), 15_000_000_000_000_000n],
  ['sender', mainnetPilotPolicy({ sender_address: OTHER_ADDRESS.toLowerCase() }), 15_000_000_000_000_000n],
  ['maximum balance', mainnetPilotPolicy({ maximum_balance_wei: '14000000000000000' }), 15_000_000_000_000_000n],
] as const) {
  test(`Mainnet pilot rejects ${name} before signing`, async () => {
    const fixture = await dependencies({ balance })
    const service = new SponsorService(
      {
        tokenContract: TOKEN,
        maxGas: 150000n,
        chainId: 1001,
        networkId: 'kaia-mainnet',
        killSwitchActive: false,
        minimumReserveWei: 10_000_000_000_000_000n,
        pilotPolicy: policy,
      },
      fixture.value,
    )

    await assert.rejects(() => service.sponsor(SENDER_RAW, MAINNET_CONTEXT), (error: unknown) => {
      assert.ok(error instanceof ServicePolicyError)
      assert.equal(error.code, 'PILOT_POLICY_NOT_READY')
      return true
    })
    assert.equal(fixture.calls.sign, 0)
    assert.equal(fixture.calls.broadcast, 0)
  })
}

test('Mainnet pilot retains one ambiguous attempt and rejects another fingerprint', async () => {
  const fixture = await dependencies({
    balance: 15_000_000_000_000_000n,
    broadcastFailure: new Error('ambiguous'),
  })
  const service = new SponsorService(
    {
      tokenContract: TOKEN,
      maxGas: 150000n,
      chainId: 1001,
      networkId: 'kaia-mainnet',
      killSwitchActive: false,
      minimumReserveWei: 10_000_000_000_000_000n,
      pilotPolicy: mainnetPilotPolicy(),
    },
    fixture.value,
  )

  await assert.rejects(() => service.sponsor(SENDER_RAW, MAINNET_CONTEXT), SponsorshipStatusUnknownError)
  const changedSignature = `${SENDER_RAW.slice(0, -1)}${SENDER_RAW.endsWith('0') ? '1' : '0'}` as Hex
  await assert.rejects(() => service.sponsor(changedSignature, MAINNET_CONTEXT), (error: unknown) => {
    assert.ok(error instanceof ServicePolicyError)
    assert.equal(error.code, 'ATTEMPT_LEDGER_FULL')
    return true
  })
  assert.equal(fixture.calls.broadcast, 1)
})

test('Mainnet pilot rejects a second identical HTTP-level attempt', async () => {
  const fixture = await dependencies({ balance: 15_000_000_000_000_000n })
  const service = new SponsorService({
    tokenContract: TOKEN,
    maxGas: 150000n,
    chainId: 1001,
    networkId: 'kaia-mainnet',
    killSwitchActive: false,
    minimumReserveWei: 10_000_000_000_000_000n,
    pilotPolicy: mainnetPilotPolicy(),
  }, fixture.value)

  await service.sponsor(SENDER_RAW, MAINNET_CONTEXT)
  await assert.rejects(
    () => service.sponsor(SENDER_RAW, MAINNET_CONTEXT),
    (error: unknown) => error instanceof ServicePolicyError
      && error.code === 'ATTEMPT_LEDGER_FULL',
  )
  assert.equal(fixture.calls.broadcast, 1)
})

test('Mainnet pilot requires exact unexpired Payment context before signing', async () => {
  for (const context of [
    undefined,
    { paymentId: 2, expiresAt: MAINNET_CONTEXT.expiresAt },
    { paymentId: 1, expiresAt: '2000-01-01T00:00:00Z' },
  ]) {
    const fixture = await dependencies({ balance: 15_000_000_000_000_000n })
    const service = new SponsorService({
      tokenContract: TOKEN,
      maxGas: 150000n,
      chainId: 1001,
      networkId: 'kaia-mainnet',
      killSwitchActive: false,
      minimumReserveWei: 10_000_000_000_000_000n,
      pilotPolicy: mainnetPilotPolicy(),
    }, fixture.value)
    await assert.rejects(() => service.sponsor(SENDER_RAW, context), ServicePolicyError)
    assert.equal(fixture.calls.sign, 0)
    assert.equal(fixture.calls.broadcast, 0)
  }
})

test('late kill switch checks block before KMS Sign and immediately before broadcast', async () => {
  for (const stage of ['signing', 'broadcast'] as const) {
    const fixture = await dependencies({
      balance: 15_000_000_000_000_000n,
      assertSigningAllowed: () => {
        if (stage === 'signing') throw new ServicePolicyError('KILL_SWITCH_ACTIVE')
      },
      assertBroadcastAllowed: () => {
        if (stage === 'broadcast') throw new ServicePolicyError('KILL_SWITCH_ACTIVE')
      },
    })
    const service = new SponsorService({
      tokenContract: TOKEN,
      maxGas: 150000n,
      chainId: 1001,
      networkId: 'kaia-mainnet',
      killSwitchActive: false,
      minimumReserveWei: 10_000_000_000_000_000n,
      pilotPolicy: mainnetPilotPolicy(),
    }, fixture.value)
    await assert.rejects(
      () => service.sponsor(SENDER_RAW, MAINNET_CONTEXT),
      (error: unknown) => error instanceof ServicePolicyError
        && error.code === 'KILL_SWITCH_ACTIVE',
    )
    assert.equal(fixture.calls.broadcast, 0)
    assert.equal(fixture.calls.sign, stage === 'signing' ? 0 : 1)
  }
})

test('expiry reached during balance or KMS work blocks the next irreversible step', async () => {
  for (const stage of ['before-sign', 'before-broadcast'] as const) {
    let currentTime = 1_000
    const fixture = await dependencies({ balance: 15_000_000_000_000_000n })
    const service = new SponsorService({
      tokenContract: TOKEN,
      maxGas: 150000n,
      chainId: 1001,
      networkId: 'kaia-mainnet',
      killSwitchActive: false,
      minimumReserveWei: 10_000_000_000_000_000n,
      pilotPolicy: mainnetPilotPolicy(),
    }, {
      ...fixture.value,
      getFeePayerBalance: async () => {
        const balance = await fixture.value.getFeePayerBalance()
        if (stage === 'before-sign') currentTime = 3_000
        return balance
      },
      signAsFeePayer: async (raw) => {
        const signed = await fixture.value.signAsFeePayer(raw)
        if (stage === 'before-broadcast') currentTime = 3_000
        return signed
      },
    }, () => currentTime)

    await assert.rejects(
      () => service.sponsor(SENDER_RAW, {
        paymentId: 1,
        expiresAt: new Date(2_000).toISOString(),
      }),
      (error: unknown) => error instanceof ServicePolicyError
        && error.code === 'PAYMENT_EXPIRED',
    )
    assert.equal(fixture.calls.sign, stage === 'before-sign' ? 0 : 1)
    assert.equal(fixture.calls.broadcast, 0)
  }
})
