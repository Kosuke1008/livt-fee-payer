import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { encodeAbiParameters } from 'viem'
import { loadConfig } from '../src/config.js'
import { NetworkProfileError } from '../src/network-profiles.js'
import { checkMainnetReadiness } from '../src/readiness.js'

const ADDRESS = '0x1111111111111111111111111111111111111111'

const validEnvironment = {
  BLOCKCHAIN_NETWORK: 'kaia-mainnet',
  FEE_PAYER_API_KEY: 'a'.repeat(64),
  MAINNET_PAYMENT_AUTHORIZATION_KEY: 'c'.repeat(64),
  FEE_PAYER_KAIA_MAINNET_RPC_URL: 'https://mainnet-primary.example.test',
  FEE_PAYER_KAIA_MAINNET_SECONDARY_RPC_URL:
    'https://mainnet-secondary.example.test',
  FEE_PAYER_KAIA_MAINNET_ADDRESS: ADDRESS,
  FEE_PAYER_KAIROS_ADDRESS: '0x2222222222222222222222222222222222222222',
  FEE_PAYER_MAINNET_SIGNER_TYPE: 'external',
  FEE_PAYER_MAINNET_SIGNER_BACKEND: 'aws-kms',
  FEE_PAYER_AWS_REGION: 'ap-northeast-1',
  FEE_PAYER_AWS_KMS_KEY_ID: 'alias/livt-mainnet-fee-payer',
  FEE_PAYER_MIN_RESERVE_KAIA: '0.1',
  FEE_PAYER_KILL_SWITCH: 'true',
  FEE_PAYER_MAINNET_ENABLED: 'false',
  SELF_HOSTED_MAINNET_FEE_PAYER_ENABLED: 'false',
  FEE_PAYER_MAINNET_SIGNING_ENABLED: 'false',
  FEE_PAYER_MAINNET_BROADCAST_ENABLED: 'false',
}

test('Mainnet readiness reads chain, token, balance, and both RPCs only', async (context) => {
  const calls = installRpc(context, 100_000_000_000_000_000n)
  const report = await checkMainnetReadiness(loadConfig(validEnvironment))

  assert.equal(report.ready, true)
  assert.equal(report.fundingStatus, 'FUNDED')
  assert.equal(report.feePayerAddress, ADDRESS)
  assert.equal(report.balanceWei, 100_000_000_000_000_000n)
  assert.equal(report.balanceKaia, '0.1')
  assert.equal(report.minimumReserveWei, 100_000_000_000_000_000n)
  assert.equal(report.minimumReserveKaia, '0.1')
  assert.equal(report.latestBlock, 16n)
  assert.equal(report.secondaryLatestBlock, 16n)
  assert.equal(calls.some((call) => call.method.includes('send')), false)
  assert.equal(calls.some((call) => call.method.includes('sign')), false)
})

test('Mainnet read-only readiness accepts zero balance as not funded', async (context) => {
  const calls = installRpc(context, 0n)
  const report = await checkMainnetReadiness(loadConfig(validEnvironment))

  assert.equal(report.ready, true)
  assert.equal(report.fundingStatus, 'NOT_FUNDED')
  assert.equal(report.balanceWei, 0n)
  assert.equal(report.balanceKaia, '0')
  assert.equal(report.minimumReserveWei, 100_000_000_000_000_000n)
  assert.equal(report.minimumReserveKaia, '0.1')
  assert.equal(calls.some((call) => call.method.includes('send')), false)
  assert.equal(calls.some((call) => call.method.includes('sign')), false)
})

test('Mainnet readiness fails safely on RPC transport failure', async (context) => {
  const originalFetch = globalThis.fetch
  context.after(() => {
    globalThis.fetch = originalFetch
  })
  globalThis.fetch = async () => {
    throw new Error('private RPC transport detail')
  }

  await assert.rejects(() =>
    checkMainnetReadiness(loadConfig(validEnvironment)),
  )
})

for (const [name, overrides] of [
  ['primary chain', { primaryChainId: '0x3e9' }],
  ['secondary chain', { secondaryChainId: '0x3e9' }],
  ['JPYC bytecode', { bytecode: '0x' }],
  ['JPYC symbol', { symbol: 'WRONG' }],
  ['JPYC decimals', { decimals: 6 }],
] as const) {
  test(`Mainnet readiness still rejects invalid ${name}`, async (context) => {
    installRpc(context, 0n, overrides)

    await assert.rejects(
      () => checkMainnetReadiness(loadConfig(validEnvironment)),
      NetworkProfileError,
    )
  })
}

test('Mainnet readiness refuses open gates or inactive kill switch before RPC access', async (context) => {
  const calls = installRpc(context, 200_000_000_000_000_000n)

  for (const [gate, unsafeValue] of [
    ['FEE_PAYER_MAINNET_ENABLED', 'true'],
    ['SELF_HOSTED_MAINNET_FEE_PAYER_ENABLED', 'true'],
    ['FEE_PAYER_MAINNET_SIGNING_ENABLED', 'true'],
    ['FEE_PAYER_MAINNET_BROADCAST_ENABLED', 'true'],
    ['FEE_PAYER_KILL_SWITCH', 'false'],
  ] as const) {
    await assert.rejects(() =>
      checkMainnetReadiness(
        loadConfig({ ...validEnvironment, [gate]: unsafeValue }),
      ),
    )
  }

  assert.equal(calls.length, 0)
})

function installRpc(
  context: TestContext,
  balance: bigint,
  overrides: {
    readonly primaryChainId?: string
    readonly secondaryChainId?: string
    readonly bytecode?: string
    readonly symbol?: string
    readonly decimals?: number
  } = {},
): Array<{ readonly method: string; readonly url: string }> {
  const originalFetch = globalThis.fetch
  context.after(() => {
    globalThis.fetch = originalFetch
  })
  const calls: Array<{ readonly method: string; readonly url: string }> = []

  globalThis.fetch = async (input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      readonly method: string
      readonly params: readonly unknown[]
    }
    calls.push({ method: request.method, url: String(input) })

    const result = rpcResult(
      request.method,
      request.params,
      balance,
      overrides,
      String(input).includes('secondary'),
    )
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return calls
}

function rpcResult(
  method: string,
  params: readonly unknown[],
  balance: bigint,
  overrides: {
    readonly primaryChainId?: string
    readonly secondaryChainId?: string
    readonly bytecode?: string
    readonly symbol?: string
    readonly decimals?: number
  },
  secondary: boolean,
): string {
  switch (method) {
    case 'eth_chainId':
      return secondary
        ? overrides.secondaryChainId ?? '0x2019'
        : overrides.primaryChainId ?? '0x2019'
    case 'eth_getCode':
      return overrides.bytecode ?? '0x6000'
    case 'eth_getBalance':
      return `0x${balance.toString(16)}`
    case 'eth_blockNumber':
      return '0x10'
    case 'eth_call': {
      const call = params[0] as { readonly data?: string }
      return call.data?.startsWith('0x95d89b41') === true
        ? encodeAbiParameters(
            [{ type: 'string' }],
            [overrides.symbol ?? 'JPYC'],
          )
        : encodeAbiParameters(
            [{ type: 'uint8' }],
            [overrides.decimals ?? 18],
          )
    }
    default:
      throw new Error(`Unexpected read-only RPC method: ${method}`)
  }
}
