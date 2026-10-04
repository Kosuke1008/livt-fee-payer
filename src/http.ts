import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Address } from 'viem'
import {
  BROADCAST_PROTOCOL_VERSION,
  type BroadcastCertainty,
} from './broadcast-certainty.js'
import type { NetworkId } from './network-profiles.js'
import {
  broadcastCertaintyForError,
  ServicePolicyError,
  SignerOperationError,
  SponsorshipStatusUnknownError,
  type SponsorService,
} from './sponsor.js'
import {
  TransactionPolicyError,
  type TransactionPolicyCode,
} from './policy.js'

const MAX_BODY_BYTES = 20_500

export type FeePayerDiagnosticCode =
  | `POLICY_REJECTED:${TransactionPolicyCode}`
  | 'MALFORMED_REQUEST'
  | 'SIGNING_FAILED'
  | 'SENDER_RECOVERY_FAILED'
  | 'BROADCAST_FAILED'
  | 'BROADCAST_HASH_MISMATCH'
  | 'RECEIPT_FAILED'
  | 'RECEIPT_HASH_MISMATCH'
  | 'REVERTED'
  | 'INTERNAL_ERROR'
  | 'EXECUTION_DISABLED'
  | 'KILL_SWITCH_ACTIVE'
  | 'INSUFFICIENT_FEE_PAYER_BALANCE'
  | 'BALANCE_UNAVAILABLE'
  | 'SIGNER_UNAVAILABLE'
  | 'SIGNER_TIMEOUT'
  | 'AUTHENTICATION_FAILURE'
  | 'INVALID_SIGNATURE'
  | 'INVALID_KEY'
  | 'KEY_MISMATCH'
  | 'SIGNING_FAILURE'
  | 'PILOT_POLICY_NOT_READY'
  | 'ATTEMPT_LEDGER_FULL'
  | 'PAYMENT_EXPIRED'
  | 'PAYMENT_AUTHORIZATION_INVALID'

export function createFeePayerServer(options: {
  readonly apiKey: string
  readonly networkId: NetworkId
  readonly feePayerAddress: Address
  readonly sponsorService: Pick<SponsorService, 'sponsor'>
  readonly sponsorshipAvailable?: () => boolean
  readonly health?: () => Promise<Record<string, unknown>>
  readonly logDiagnostic?: (code: FeePayerDiagnosticCode) => void
}): Server {
  const logDiagnostic = options.logDiagnostic ?? defaultDiagnosticLogger

  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')

    if (request.method === 'GET' && request.url === '/health') {
      try {
        const health = options.health === undefined
          ? {
              status: 'ok',
              network: options.networkId,
              fee_payer_address: options.feePayerAddress,
            }
          : await options.health()
        response.writeHead(200)
        response.end(JSON.stringify(health))
      } catch {
        response.writeHead(503)
        response.end(JSON.stringify({ status: 'NOT_READY' }))
      }
      return
    }

    if (request.method !== 'POST' || request.url !== '/api/signAsFeePayer') {
      respondError(response, 404, 'NOT_FOUND', 'definitely_not_broadcast')
      return
    }
    if (!authorized(request, options.apiKey)) {
      respondError(response, 401, 'BAD_REQUEST', 'definitely_not_broadcast')
      return
    }
    if (options.sponsorshipAvailable?.() === false) {
      logDiagnostic('EXECUTION_DISABLED')
      respondError(
        response,
        503,
        'SERVICE_UNAVAILABLE',
        'definitely_not_broadcast',
      )
      return
    }
    if (!request.headers['content-type']?.startsWith('application/json')) {
      respondError(response, 415, 'BAD_REQUEST', 'definitely_not_broadcast')
      return
    }

    try {
      const body = await readJson(request)
      const values = bodyValue(body)
      const result = await options.sponsorService.sponsor(values.raw, {
        paymentId: values.paymentId,
        expiresAt: values.expiresAt,
        paymentAuthorization: values.paymentAuthorization,
      })

      if (result.broadcastCertainty !== 'submitted') {
        throw new Error('Invalid sponsorship result certainty')
      }

      if (result.status === 'reverted') logDiagnostic('REVERTED')

      respond(response, 200, {
        status: result.status === 'success',
        ...(result.status === 'reverted' ? { error: 'REVERTED' } : {}),
        protocol_version: BROADCAST_PROTOCOL_VERSION,
        broadcast_certainty: result.broadcastCertainty,
        data: {
          status: result.status === 'success' ? '0x1' : '0x0',
          hash: result.hash,
          transactionHash: result.hash,
        },
      })
    } catch (error) {
      if (error instanceof TransactionPolicyError) {
        logDiagnostic(`POLICY_REJECTED:${error.code}`)
        respondError(
          response,
          400,
          'BAD_REQUEST',
          broadcastCertaintyForError(error),
        )
        return
      }
      if (error instanceof SyntaxError) {
        logDiagnostic('MALFORMED_REQUEST')
        respondError(response, 400, 'BAD_REQUEST', 'definitely_not_broadcast')
        return
      }
      if (error instanceof SponsorshipStatusUnknownError) {
        logDiagnostic(diagnosticCode(error))
        respondError(
          response,
          503,
          'INTERNAL_ERROR',
          broadcastCertaintyForError(error),
        )
        return
      }
      if (error instanceof SignerOperationError) {
        logDiagnostic(error.code)
        respondError(
          response,
          503,
          error.code,
          broadcastCertaintyForError(error),
        )
        return
      }
      if (error instanceof ServicePolicyError) {
        logDiagnostic(error.code)
        respondError(
          response,
          503,
          error.code === 'KILL_SWITCH_ACTIVE'
            || error.code === 'PAYMENT_EXPIRED'
            ? error.code
            : 'SERVICE_UNAVAILABLE',
          broadcastCertaintyForError(error),
        )
        return
      }
      logDiagnostic('INTERNAL_ERROR')
      respondError(response, 500, 'INTERNAL_ERROR', 'broadcast_possible')
    }
  })
}

function diagnosticCode(
  error: SponsorshipStatusUnknownError,
): FeePayerDiagnosticCode {
  switch (error.stage) {
    case 'signing':
      return 'SIGNING_FAILED'
    case 'sender-recovery':
      return 'SENDER_RECOVERY_FAILED'
    case 'broadcast':
      return 'BROADCAST_FAILED'
    case 'broadcast-hash':
      return 'BROADCAST_HASH_MISMATCH'
    case 'receipt':
      return 'RECEIPT_FAILED'
    case 'receipt-hash':
      return 'RECEIPT_HASH_MISMATCH'
  }
}

function defaultDiagnosticLogger(code: FeePayerDiagnosticCode): void {
  process.stderr.write(`[LivT Fee Payer] ${code}\n`)
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7))
  const wanted = Buffer.from(expected)
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      throw new TransactionPolicyError('REQUEST_TOO_LARGE')
    }
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function bodyValue(body: unknown): {
  readonly raw: unknown
  readonly paymentId: unknown
  readonly expiresAt: unknown
  readonly paymentAuthorization: unknown
} {
  if (typeof body !== 'object' || body === null) {
    return {
      raw: undefined,
      paymentId: undefined,
      expiresAt: undefined,
      paymentAuthorization: undefined,
    }
  }
  const userSignedTx = Reflect.get(body, 'userSignedTx')
  return {
    raw: typeof userSignedTx === 'object' && userSignedTx !== null
      ? Reflect.get(userSignedTx, 'raw')
      : undefined,
    paymentId: Reflect.get(body, 'paymentId'),
    expiresAt: Reflect.get(body, 'expiresAt'),
    paymentAuthorization: Reflect.get(body, 'paymentAuthorization'),
  }
}

function respond(
  response: import('node:http').ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(status)
  response.end(JSON.stringify(body))
}

function respondError(
  response: import('node:http').ServerResponse,
  status: number,
  error: string,
  broadcastCertainty: BroadcastCertainty,
): void {
  respond(response, status, {
    status: false,
    error,
    protocol_version: BROADCAST_PROTOCOL_VERSION,
    broadcast_certainty: broadcastCertainty,
  })
}
