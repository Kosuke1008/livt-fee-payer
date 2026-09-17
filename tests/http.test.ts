import assert from 'node:assert/strict'
import test from 'node:test'
import type { Hash } from 'viem'
import { BROADCAST_PROTOCOL_VERSION } from '../src/broadcast-certainty.js'
import {
  createFeePayerServer,
  type FeePayerDiagnosticCode,
} from '../src/http.js'
import { TransactionPolicyError } from '../src/policy.js'
import {
  ServicePolicyError,
  SignerOperationError,
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
        return {
          hash: TX_HASH,
          status: 'success',
          broadcastCertainty: 'submitted',
        }
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
  assert.deepEqual(await unauthorized.json(), {
    status: false,
    error: 'BAD_REQUEST',
    protocol_version: BROADCAST_PROTOCOL_VERSION,
    broadcast_certainty: 'definitely_not_broadcast',
  })
  assert.equal(calls, 0)

  const response = await post(url, SENDER_RAW)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    status: true,
    protocol_version: BROADCAST_PROTOCOL_VERSION,
    broadcast_certainty: 'submitted',
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
  const rejectedText = await rejected.text()
  assert.equal(rejectedText.includes('raw transaction detail'), false)
  assert.equal(rejectedText.includes(SENDER_RAW), false)
  assert.deepEqual(JSON.parse(rejectedText), {
    status: false,
    error: 'BAD_REQUEST',
    protocol_version: BROADCAST_PROTOCOL_VERSION,
    broadcast_certainty: 'definitely_not_broadcast',
  })

  const unknown = await post(url, SENDER_RAW)
  assert.equal(unknown.status, 503)
  const body = await unknown.text()
  assert.equal(body.includes('private RPC'), false)
  assert.equal(body.includes('URL'), false)
  assert.equal(body.includes(SENDER_RAW), false)
  assert.deepEqual(JSON.parse(body), {
    status: false,
    error: 'INTERNAL_ERROR',
    protocol_version: BROADCAST_PROTOCOL_VERSION,
    broadcast_certainty: 'broadcast_possible',
  })
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
        return {
          hash: TX_HASH,
          status: result,
          broadcastCertainty: 'submitted',
        }
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
  assert.deepEqual(await malformed.json(), {
    status: false,
    error: 'BAD_REQUEST',
    protocol_version: BROADCAST_PROTOCOL_VERSION,
    broadcast_certainty: 'definitely_not_broadcast',
  })

  const reverted = await post(url, SENDER_RAW)
  assert.equal(reverted.status, 200)
  assert.deepEqual(await reverted.json(), {
    status: false,
    error: 'REVERTED',
    protocol_version: BROADCAST_PROTOCOL_VERSION,
    broadcast_certainty: 'submitted',
    data: { status: '0x0', hash: TX_HASH, transactionHash: TX_HASH },
  })

  const unexpected = await post(url, SENDER_RAW)
  assert.equal(unexpected.status, 500)
  assert.deepEqual(await unexpected.json(), {
    status: false,
    error: 'INTERNAL_ERROR',
    protocol_version: BROADCAST_PROTOCOL_VERSION,
    broadcast_certainty: 'broadcast_possible',
  })
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
    error: 'KILL_SWITCH_ACTIVE',
    protocol_version: BROADCAST_PROTOCOL_VERSION,
    broadcast_certainty: 'definitely_not_broadcast',
  })
  assert.deepEqual(diagnostics, ['KILL_SWITCH_ACTIVE'])
  assert.equal(JSON.stringify(diagnostics).includes(API_KEY), false)
  assert.equal(JSON.stringify(diagnostics).includes(SENDER_RAW), false)
})

test('live-capable server keeps sponsorship unavailable while runtime gates are closed', async (context) => {
  let calls = 0
  const server = createFeePayerServer({
    apiKey: API_KEY,
    networkId: 'kaia-mainnet',
    feePayerAddress: SENDER,
    sponsorshipAvailable: () => false,
    sponsorService: {
      sponsor: async () => {
        calls++
        return {
          hash: TX_HASH,
          status: 'success',
          broadcastCertainty: 'submitted',
        }
      },
    },
  })
  const url = await listen(server)
  context.after(() => server.close())

  const response = await post(url, SENDER_RAW)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), {
    status: false,
    error: 'SERVICE_UNAVAILABLE',
    protocol_version: BROADCAST_PROTOCOL_VERSION,
    broadcast_certainty: 'definitely_not_broadcast',
  })
  assert.equal(calls, 0)
})

test('returns a fixed pre-broadcast signer timeout', async (context) => {
  const diagnostics: FeePayerDiagnosticCode[] = []
  const server = createFeePayerServer({
    apiKey: API_KEY,
    networkId: 'kaia-mainnet',
    feePayerAddress: SENDER,
    sponsorService: {
      sponsor: async () => { throw new SignerOperationError('SIGNER_TIMEOUT') },
    },
    logDiagnostic: (code) => diagnostics.push(code),
  })
  const url = await listen(server)
  context.after(() => server.close())

  const response = await post(url, SENDER_RAW)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), {
    status: false,
    error: 'SIGNER_TIMEOUT',
    protocol_version: BROADCAST_PROTOCOL_VERSION,
    broadcast_certainty: 'definitely_not_broadcast',
  })
  assert.deepEqual(diagnostics, ['SIGNER_TIMEOUT'])
})

test('malformed internal certainty fails closed as broadcast possible', async (context) => {
  const server = createFeePayerServer({
    apiKey: API_KEY,
    networkId: 'kairos',
    feePayerAddress: SENDER,
    sponsorService: {
      sponsor: async () => ({
        hash: TX_HASH,
        status: 'success',
        broadcastCertainty: 'invalid',
      }) as never,
    },
  })
  const url = await listen(server)
  context.after(() => server.close())

  const response = await post(url, SENDER_RAW)
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), {
    status: false,
    error: 'INTERNAL_ERROR',
    protocol_version: BROADCAST_PROTOCOL_VERSION,
    broadcast_certainty: 'broadcast_possible',
  })
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
