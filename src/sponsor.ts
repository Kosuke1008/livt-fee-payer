import { createHash } from 'node:crypto'
import {
  createWalletClient,
  privateKeyToAccount,
} from '@kaiachain/viem-ext'
import {
  createPublicClient,
  getAddress,
  http,
  isAddressEqual,
  isHash,
  keccak256,
  type Address,
  type Hash,
  type Hex,
} from 'viem'
import type { FeePayerConfig } from './config.js'
import { assertFeePayerExecutionAllowed } from './network-profiles.js'
import {
  TransactionPolicyError,
  validateFeePayerTransaction,
  validateSenderTransaction,
} from './policy.js'

export interface SponsorshipReceipt {
  readonly transactionHash: Hash
  readonly status: 'success' | 'reverted'
}

export interface SponsorDependencies {
  readonly feePayerAddress: Address
  readonly signAsFeePayer: (senderRaw: Hex) => Promise<Hex>
  readonly recoverSender: (fullRaw: Hex) => Promise<Address>
  readonly broadcast: (fullRaw: Hex) => Promise<Hash>
  readonly waitForReceipt: (hash: Hash) => Promise<SponsorshipReceipt>
}

export interface SponsorshipResult {
  readonly hash: Hash
  readonly status: 'success' | 'reverted'
}

export type SponsorshipFailureStage =
  | 'signing'
  | 'sender-recovery'
  | 'broadcast'
  | 'broadcast-hash'
  | 'receipt'
  | 'receipt-hash'

export class SponsorshipStatusUnknownError extends Error {
  override readonly name = 'SponsorshipStatusUnknownError'

  constructor(
    readonly stage: SponsorshipFailureStage,
    options?: ErrorOptions,
  ) {
    super('Fee sponsorship status is unknown', options)
  }
}

export class SponsorService {
  private readonly attempts = new Map<string, Promise<SponsorshipResult>>()

  constructor(
    private readonly config: Pick<
      FeePayerConfig,
      'tokenContract' | 'maxGas' | 'chainId'
    >,
    private readonly dependencies: SponsorDependencies,
  ) {}

  async sponsor(raw: unknown): Promise<SponsorshipResult> {
    const sender = validateSenderTransaction(
      raw,
      this.config.tokenContract,
      this.config.maxGas,
      this.config.chainId,
    )
    const fingerprint = createHash('sha256').update(sender.raw).digest('hex')
    const existing = this.attempts.get(fingerprint)
    if (existing !== undefined) return existing

    const attempt = this.execute(sender)
    this.attempts.set(fingerprint, attempt)
    this.trimAttempts()

    try {
      const result = await attempt
      if (result.status === 'reverted') this.attempts.delete(fingerprint)
      return result
    } catch (error) {
      if (error instanceof TransactionPolicyError) {
        this.attempts.delete(fingerprint)
      }
      throw error
    }
  }

  private async execute(
    sender: ReturnType<typeof validateSenderTransaction>,
  ): Promise<SponsorshipResult> {
    let fullRaw: Hex
    try {
      fullRaw = await this.dependencies.signAsFeePayer(sender.raw)
    } catch (error) {
      throw new SponsorshipStatusUnknownError('signing', {
        cause: error,
      })
    }

    validateFeePayerTransaction(
      fullRaw,
      sender,
      this.dependencies.feePayerAddress,
      this.config.chainId,
    )

    let recovered: Address
    try {
      recovered = getAddress(
        await this.dependencies.recoverSender(fullRaw),
      )
    } catch (error) {
      throw new SponsorshipStatusUnknownError('sender-recovery', {
        cause: error,
      })
    }
    if (!isAddressEqual(recovered, sender.sender)) {
      throw new TransactionPolicyError('SENDER_SIGNATURE_MISMATCH')
    }

    const expectedHash = keccak256(fullRaw)
    let broadcastHash: Hash
    try {
      broadcastHash = await this.dependencies.broadcast(fullRaw)
    } catch (error) {
      throw new SponsorshipStatusUnknownError('broadcast', {
        cause: error,
      })
    }
    if (!isHash(broadcastHash) || broadcastHash.toLowerCase() !== expectedHash) {
      throw new SponsorshipStatusUnknownError('broadcast-hash')
    }

    let receipt: SponsorshipReceipt
    try {
      receipt = await this.dependencies.waitForReceipt(expectedHash)
    } catch (error) {
      throw new SponsorshipStatusUnknownError('receipt', {
        cause: error,
      })
    }
    if (receipt.transactionHash.toLowerCase() !== expectedHash) {
      throw new SponsorshipStatusUnknownError('receipt-hash')
    }

    return { hash: expectedHash, status: receipt.status }
  }

  private trimAttempts(): void {
    while (this.attempts.size > 1000) {
      const oldest = this.attempts.keys().next().value as string | undefined
      if (oldest === undefined) return
      this.attempts.delete(oldest)
    }
  }
}

export function createSponsorDependencies(
  config: FeePayerConfig,
): SponsorDependencies {
  assertFeePayerExecutionAllowed(config.profile)
  if (config.privateKey === null) {
    throw new Error('Fee-payer signing key is unavailable')
  }

  const account = privateKeyToAccount(config.privateKey)
  const wallet = createWalletClient({
    account,
    chain: config.profile.chain,
    transport: http(config.rpcUrl, { retryCount: 0, timeout: 10_000 }),
  })
  const publicClient = createPublicClient({
    chain: config.profile.chain,
    transport: http(config.rpcUrl, { retryCount: 0, timeout: 10_000 }),
  })

  return {
    feePayerAddress: account.address,
    signAsFeePayer: async (senderRaw) =>
      (await wallet.signTransactionAsFeePayer(senderRaw)) as Hex,
    recoverSender: async (fullRaw) => {
      const result = await rpc<Address>(config.rpcUrl, {
        method: 'kaia_recoverFromTransaction',
        params: [fullRaw, 'latest'],
      })
      return getAddress(result)
    },
    broadcast: async (fullRaw) => {
      const result = await rpc<Hash>(config.rpcUrl, {
        method: 'kaia_sendRawTransaction',
        params: [fullRaw],
      })
      if (!isHash(result)) throw new Error('Invalid broadcast response')
      return result
    },
    waitForReceipt: async (hash) => {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        pollingInterval: 1000,
        timeout: config.receiptTimeoutMs,
      })
      return {
        transactionHash: receipt.transactionHash,
        status: receipt.status,
      }
    },
  }
}

async function rpc<Result>(
  rpcUrl: string,
  request: { readonly method: string; readonly params: readonly unknown[] },
): Promise<Result> {
  let response: Response
  try {
    response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: request.method,
        params: request.params,
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    throw new Error('Kairos RPC transport failure', { cause: error })
  }
  if (!response.ok) throw new Error('Kairos RPC HTTP failure')

  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    throw new Error('Kairos RPC response failure', { cause: error })
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    'error' in body ||
    !('result' in body)
  ) {
    throw new Error('Kairos RPC response failure')
  }
  return body.result as Result
}
