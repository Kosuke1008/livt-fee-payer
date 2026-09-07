import assert from 'node:assert/strict'
import test from 'node:test'
import type { Hash } from 'viem'
import {
  createFeePayerServer,
  type FeePayerDiagnosticCode,
} from '../src/http.js'
import { TransactionPolicyError } from '../src/policy.js'
import {
  ServicePolicyError,
  SponsorshipStatusUnknownError,
} from '../src/sponsor.js'
import { SENDER, SENDER_RAW } from './fixtures.js'

const API_KEY = 'b'.repeat(64)
const TX_HASH = `0x${'ab'.repeat(32)}` as Hash

test('requires bearer authentication and returns the FDS-compatible success shape', async (context) => {
  let calls = 0
  const server = createFeePayerServer({
    apiKey: API_KEY,
    networkId: 'kairos',
    feePayerAddress: SENDER,
    sponsorService: {
      sponsor: async (raw) => {
        calls++
        assert.equal(raw, SENDER_RAW)
        return { hash: TX_HASH, status: 'success' }
      },
    },
  })
  const url = await listen(server)
  context.after(() => server.close())

  const health = await fetch(new URL('/health', url))
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), {
    status: 'ok',
    network: 'kairos',
    fee_payer_address: SENDER,
  })

  const unauthorized = await fetch(new URL('/api/signAsFeePayer', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userSignedTx: { raw: SENDER_RAW } }),
  })
  assert.equal(unauthorized.status, 401)
  assert.equal(calls, 0)

  const response = await post(url, SENDER_RAW)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    status: true,
    data: { status: '0x1', hash: TX_HASH, transactionHash: TX_HASH },
  })
  assert.equal(calls, 1)
})

test('maps policy and unknown failures without leaking internal messages', async (context) => {
  const diagnostics: FeePayerDiagnosticCode[] = []
  const errors = [
    new TransactionPolicyError('INVALID_SENDER_TRANSACTION'),
    new SponsorshipStatusUnknownError('broadcast', {
      cause: new Error('private RPC URL and message'),
    }),
  ]
  let index = 0
  const server = createFeePayerServer({
    apiKey: API_KEY,
    networkId: 'kairos',
    feePayerAddress: SENDER,
    sponsorService: {
      sponsor: async () => {
        throw errors[index++]
      },
    },
    logDiagnostic: (code) => diagnostics.push(code),
  })
  const url = await listen(server)
  context.after(() => server.close())

  const rejected = await post(url, SENDER_RAW)
  assert.equal(rejected.status, 400)
  assert.equal((await rejected.text()).includes('raw transaction detail'), false)

  const unknown = await post(url, SENDER_RAW)
  assert.equal(unknown.status, 503)
  const body = await unknown.text()
  assert.equal(body.includes('private RPC'), false)
  assert.equal(body.includes('URL'), false)
  assert.deepEqual(diagnostics, [
    'POLICY_REJECTED:INVALID_SENDER_TRANSACTION',
    'BROADCAST_FAILED',
  ])
  assert.equal(JSON.stringify(diagnostics).includes(SENDER_RAW), false)
  assert.equal(JSON.stringify(diagnostics).includes(API_KEY), false)
  assert.equal(JSON.stringify(diagnostics).includes('private RPC'), false)
})

test('logs only fixed diagnostic codes for malformed, reverted, and unexpected failures', async (context) => {
  const diagnostics: FeePayerDiagnosticCode[] = []
  const results: Array<'reverted' | Error> = [
    'reverted',
    new Error(`unexpected ${API_KEY} ${SENDER_RAW}`),
  ]
  let index = 0
  const server = createFeePayerServer({
    apiKey: API_KEY,
    networkId: 'kairos',
    feePayerAddress: SENDER,
    sponsorService: {
      sponsor: async () => {
        const result = results[index++]
        if (result instanceof Error) throw result
        if (result !== 'reverted') throw new Error('Missing test result')
        return { hash: TX_HASH, status: result }
      },
    },
    logDiagnostic: (code) => diagnostics.push(code),
  })
  const url = await listen(server)
  context.after(() => server.close())

  const malformed = await fetch(new URL('/api/signAsFeePayer', url), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: '{',
  })
  assert.equal(malformed.status, 400)

  const reverted = await post(url, SENDER_RAW)
  assert.equal(reverted.status, 200)
  assert.deepEqual(await reverted.json(), {
    status: false,
    error: 'REVERTED',
    data: { status: '0x0', hash: TX_HASH, transactionHash: TX_HASH },
  })

  const unexpected = await post(url, SENDER_RAW)
  assert.equal(unexpected.status, 500)
  assert.deepEqual(diagnostics, [
    'MALFORMED_REQUEST',
    'REVERTED',
    'INTERNAL_ERROR',
  ])
  const output = JSON.stringify(diagnostics)
  assert.equal(output.includes(API_KEY), false)
  assert.equal(output.includes(SENDER_RAW), false)
})

test('kill switch response is fixed and redacts internal values', async (context) => {
  const diagnostics: FeePayerDiagnosticCode[] = []
  const server = createFeePayerServer({
    apiKey: API_KEY,
    networkId: 'kairos',
    feePayerAddress: SENDER,
    sponsorService: {
      sponsor: async () => {
        throw new ServicePolicyError('KILL_SWITCH_ACTIVE')
      },
    },
    logDiagnostic: (code) => diagnostics.push(code),
  })
  const url = await listen(server)
  context.after(() => server.close())

  const response = await post(url, SENDER_RAW)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), {
    status: false,
    error: 'SERVICE_UNAVAILABLE',
  })
  assert.deepEqual(diagnostics, ['KILL_SWITCH_ACTIVE'])
  assert.equal(JSON.stringify(diagnostics).includes(API_KEY), false)
  assert.equal(JSON.stringify(diagnostics).includes(SENDER_RAW), false)
})

async function listen(server: ReturnType<typeof createFeePayerServer>): Promise<URL> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) {
    throw new Error('Test server did not bind')
  }
  return new URL(`http://127.0.0.1:${address.port}`)
}

function post(url: URL, raw: string): Promise<Response> {
  return fetch(new URL('/api/signAsFeePayer', url), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ userSignedTx: { raw } }),
  })
}
