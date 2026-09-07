import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Address } from 'viem'
import type { NetworkId } from './network-profiles.js'
import {
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

export function createFeePayerServer(options: {
  readonly apiKey: string
  readonly networkId: NetworkId
  readonly feePayerAddress: Address
  readonly sponsorService: Pick<SponsorService, 'sponsor'>
  readonly logDiagnostic?: (code: FeePayerDiagnosticCode) => void
}): Server {
  const logDiagnostic = options.logDiagnostic ?? defaultDiagnosticLogger

  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')

    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200)
      response.end(
        JSON.stringify({
          status: 'ok',
          network: options.networkId,
          fee_payer_address: options.feePayerAddress,
        }),
      )
      return
    }

    if (request.method !== 'POST' || request.url !== '/api/signAsFeePayer') {
      respond(response, 404, { status: false, error: 'NOT_FOUND' })
      return
    }
    if (!authorized(request, options.apiKey)) {
      respond(response, 401, { status: false, error: 'BAD_REQUEST' })
      return
    }
    if (!request.headers['content-type']?.startsWith('application/json')) {
      respond(response, 415, { status: false, error: 'BAD_REQUEST' })
      return
    }

    try {
      const body = await readJson(request)
      const raw = bodyValue(body)
      const result = await options.sponsorService.sponsor(raw)

      if (result.status === 'reverted') logDiagnostic('REVERTED')

      respond(response, 200, {
        status: result.status === 'success',
        ...(result.status === 'reverted' ? { error: 'REVERTED' } : {}),
        data: {
          status: result.status === 'success' ? '0x1' : '0x0',
          hash: result.hash,
          transactionHash: result.hash,
        },
      })
    } catch (error) {
      if (error instanceof TransactionPolicyError) {
        logDiagnostic(`POLICY_REJECTED:${error.code}`)
        respond(response, 400, { status: false, error: 'BAD_REQUEST' })
        return
      }
      if (error instanceof SyntaxError) {
        logDiagnostic('MALFORMED_REQUEST')
        respond(response, 400, { status: false, error: 'BAD_REQUEST' })
        return
      }
      if (error instanceof SponsorshipStatusUnknownError) {
        logDiagnostic(diagnosticCode(error))
        respond(response, 503, { status: false, error: 'INTERNAL_ERROR' })
        return
      }
      logDiagnostic('INTERNAL_ERROR')
      respond(response, 500, { status: false, error: 'INTERNAL_ERROR' })
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

function bodyValue(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return undefined
  const userSignedTx = Reflect.get(body, 'userSignedTx')
  if (typeof userSignedTx !== 'object' || userSignedTx === null) return undefined
  return Reflect.get(userSignedTx, 'raw')
}

function respond(
  response: import('node:http').ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(status)
  response.end(JSON.stringify(body))
}
