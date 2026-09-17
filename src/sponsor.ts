import { createHash } from 'node:crypto'
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
import {
  isBroadcastCertainty,
  type BroadcastCertainty,
} from './broadcast-certainty.js'
import {
  assertFeePayerExecutionAllowed,
  NetworkExecutionDisabledError,
} from './network-profiles.js'
import {
  createFeePayerSigner,
  ExternalSignerError,
  type ExternalSignerErrorCode,
  type FeePayerSigner,
} from './signer.js'
import {
  TransactionPolicyError,
  validateFeePayerTransaction,
  validateSenderTransaction,
} from './policy.js'
import { isKillSwitchActive } from './kill-switch.js'

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
  readonly getFeePayerBalance: () => Promise<bigint>
  readonly assertSigningAllowed?: () => void
  readonly assertBroadcastAllowed?: () => void
}

export interface SponsorshipResult {
  readonly hash: Hash
  readonly status: 'success' | 'reverted'
  readonly broadcastCertainty: 'submitted'
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

  readonly broadcastCertainty: BroadcastCertainty

  constructor(
    readonly stage: SponsorshipFailureStage,
    options?: ErrorOptions,
  ) {
    super('Fee sponsorship status is unknown', options)
    this.broadcastCertainty = certaintyForFailureStage(stage)
  }
}

export class SignerOperationError extends Error {
  override readonly name = 'SignerOperationError'

  readonly broadcastCertainty = 'definitely_not_broadcast' as const

  constructor(readonly code: ExternalSignerErrorCode) {
    super('Fee-payer signing failed before broadcast')
  }
}

export type ServicePolicyCode =
  | 'KILL_SWITCH_ACTIVE'
  | 'INSUFFICIENT_FEE_PAYER_BALANCE'
  | 'BALANCE_UNAVAILABLE'
  | 'EXECUTION_DISABLED'
  | 'PILOT_POLICY_NOT_READY'
  | 'ATTEMPT_LEDGER_FULL'
  | 'PAYMENT_EXPIRED'

export class ServicePolicyError extends Error {
  override readonly name = 'ServicePolicyError'

  readonly broadcastCertainty = 'definitely_not_broadcast' as const

  constructor(readonly code: ServicePolicyCode) {
    super('Fee sponsorship is unavailable')
  }
}

export class SponsorService {
  private readonly attempts = new Map<string, Promise<SponsorshipResult>>()

  constructor(
    private readonly config: Pick<
      FeePayerConfig,
      | 'tokenContract'
      | 'maxGas'
      | 'chainId'
      | 'killSwitchActive'
      | 'minimumReserveWei'
    > & Partial<Pick<FeePayerConfig, 'networkId' | 'pilotPolicy'>>,
    private readonly dependencies: SponsorDependencies,
    private readonly now: () => number = Date.now,
  ) {}

  async sponsor(
    raw: unknown,
    context?: { readonly paymentId: unknown; readonly expiresAt: unknown },
  ): Promise<SponsorshipResult> {
    if (this.config.killSwitchActive) {
      throw new ServicePolicyError('KILL_SWITCH_ACTIVE')
    }

    const sender = validateSenderTransaction(
      raw,
      this.config.tokenContract,
      this.config.maxGas,
      this.config.chainId,
    )
    let expiresAt: number | null = null
    if (this.config.networkId === 'kaia-mainnet') {
      expiresAt = typeof context?.expiresAt === 'string'
        ? Date.parse(context.expiresAt)
        : Number.NaN
      if (this.config.pilotPolicy?.ready !== true
        || String(context?.paymentId ?? '') !== this.config.pilotPolicy.pilot_payment_id
        || !Number.isFinite(expiresAt)
        || expiresAt <= this.now()) {
        throw new ServicePolicyError('PILOT_POLICY_NOT_READY')
      }
    }
    const fingerprint = createHash('sha256').update(sender.raw).digest('hex')
    const existing = this.attempts.get(fingerprint)
    if (existing !== undefined) {
      if (this.config.networkId === 'kaia-mainnet') {
        throw new ServicePolicyError('ATTEMPT_LEDGER_FULL')
      }
      return existing
    }
    if (this.config.networkId === 'kaia-mainnet' && this.attempts.size >= 1) {
      throw new ServicePolicyError('ATTEMPT_LEDGER_FULL')
    }
    if (this.attempts.size >= 1000) {
      throw new ServicePolicyError('ATTEMPT_LEDGER_FULL')
    }

    const attempt = this.execute(sender, expiresAt)
    this.attempts.set(fingerprint, attempt)

    try {
      const result = await attempt
      return result
    } catch (error) {
      if (broadcastCertaintyForError(error) === 'definitely_not_broadcast') {
        this.attempts.delete(fingerprint)
      }
      throw error
    }
  }

  private async execute(
    sender: ReturnType<typeof validateSenderTransaction>,
    expiresAt: number | null,
  ): Promise<SponsorshipResult> {
    let balance: bigint
    try {
      balance = await this.dependencies.getFeePayerBalance()
    } catch {
      throw new ServicePolicyError('BALANCE_UNAVAILABLE')
    }
    let requiredBalance = this.config.minimumReserveWei
    if (this.config.networkId === 'kaia-mainnet') {
      const policy = this.config.pilotPolicy
      if (policy?.ready !== true || policy.max_gas_price_wei === ''
        || policy.maximum_balance_wei === '' || policy.merchant_address === ''
        || policy.sender_address === ''
        || policy.max_payment_jpyc !== '1'
        || sender.gasLimit > BigInt(policy.max_gas)
        || sender.gasPrice > BigInt(policy.max_gas_price_wei)
        || sender.recipient.toLowerCase() !== policy.merchant_address
        || sender.sender.toLowerCase() !== policy.sender_address
        || sender.atomicAmount !== 10n ** 18n
        || balance > BigInt(policy.maximum_balance_wei)) {
        throw new ServicePolicyError('PILOT_POLICY_NOT_READY')
      }
      requiredBalance += sender.gasLimit * sender.gasPrice
    }
    if (balance < requiredBalance) {
      throw new ServicePolicyError('INSUFFICIENT_FEE_PAYER_BALANCE')
    }

    this.assertNotExpired(expiresAt)
    this.dependencies.assertSigningAllowed?.()
    let fullRaw: Hex
    try {
      fullRaw = await this.dependencies.signAsFeePayer(sender.raw)
    } catch (error) {
      if (error instanceof ServicePolicyError) throw error
      throw new SignerOperationError(
        error instanceof ExternalSignerError ? error.code : 'SIGNING_FAILURE',
      )
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
    this.assertNotExpired(expiresAt)
    this.dependencies.assertBroadcastAllowed?.()
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

    return {
      hash: expectedHash,
      status: receipt.status,
      broadcastCertainty: 'submitted',
    }
  }

  private assertNotExpired(expiresAt: number | null): void {
    if (this.config.networkId === 'kaia-mainnet'
      && (expiresAt === null || expiresAt <= this.now())) {
      throw new ServicePolicyError('PAYMENT_EXPIRED')
    }
  }

}

export function broadcastCertaintyForError(
  error: unknown,
): BroadcastCertainty {
  if (error instanceof TransactionPolicyError
    || error instanceof SignerOperationError
    || error instanceof ServicePolicyError) {
    return 'definitely_not_broadcast'
  }
  if (error instanceof SponsorshipStatusUnknownError) {
    return isBroadcastCertainty(error.broadcastCertainty)
      ? error.broadcastCertainty
      : 'broadcast_possible'
  }
  return 'broadcast_possible'
}

function certaintyForFailureStage(
  stage: SponsorshipFailureStage,
): BroadcastCertainty {
  switch (stage) {
    case 'signing':
    case 'sender-recovery':
      return 'definitely_not_broadcast'
    case 'broadcast':
    case 'broadcast-hash':
      return 'broadcast_possible'
    case 'receipt':
    case 'receipt-hash':
      return 'submitted'
  }
}

export function createSponsorDependencies(
  config: FeePayerConfig,
  signer: FeePayerSigner = createFeePayerSigner(config),
): SponsorDependencies {
  try {
    assertFeePayerExecutionAllowed(config.profile)
  } catch (error) {
    if (error instanceof NetworkExecutionDisabledError) {
      throw new ServicePolicyError('EXECUTION_DISABLED')
    }
    throw error
  }
  if (!config.profile.signingEnabled || !config.profile.broadcastEnabled) {
    throw new ServicePolicyError('EXECUTION_DISABLED')
  }
  const assertLiveGate = (stage: 'signing' | 'broadcast'): void => {
    if (config.networkId !== 'kaia-mainnet') return
    if (!config.activationReleaseCapable
      || !config.mainnetEnabled
      || !config.selfHostedMainnetEnabled
      || !config.mainnetSigningEnabled
      || !config.mainnetBroadcastEnabled
      || isKillSwitchActive(config.killSwitchActive)
      || config.signerType !== 'external'
      || config.mainnetSignerBackend !== 'aws-kms') {
      throw new ServicePolicyError(
        isKillSwitchActive(config.killSwitchActive) ? 'KILL_SWITCH_ACTIVE' : 'EXECUTION_DISABLED',
      )
    }
    if (stage === 'signing' && !config.mainnetSigningEnabled) {
      throw new ServicePolicyError('EXECUTION_DISABLED')
    }
  }
  const publicClient = createPublicClient({
    chain: config.profile.chain,
    transport: http(config.rpcUrl, { retryCount: 0, timeout: 10_000 }),
  })

  return {
    feePayerAddress: signer.address,
    signAsFeePayer: async (senderRaw) =>
      (await signer.signAsFeePayer({
        senderRaw,
        assertAssemblyAllowed: () => assertLiveGate('signing'),
      })).signedRaw,
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
    getFeePayerBalance: () =>
      publicClient.getBalance({ address: signer.address }),
    assertSigningAllowed: () => assertLiveGate('signing'),
    assertBroadcastAllowed: () => assertLiveGate('broadcast'),
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
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
  } catch (error) {
    throw new Error('Kaia RPC transport failure', { cause: error })
  }
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 1_000_000) {
    throw new Error('Kaia RPC HTTP failure')
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    throw new Error('Kairos RPC response failure', { cause: error })
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    Reflect.get(body, 'jsonrpc') !== '2.0' ||
    Reflect.get(body, 'id') !== 1 ||
    'error' in body ||
    !('result' in body)
  ) {
    throw new Error('Kairos RPC response failure')
  }
  return body.result as Result
}
