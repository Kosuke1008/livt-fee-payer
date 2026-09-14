import { createHash, createPublicKey } from 'node:crypto'
import {
  DescribeKeyCommand,
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
} from '@aws-sdk/client-kms'
import { createWalletClient, privateKeyToAccount } from '@kaiachain/viem-ext'
import { getAddress, http, isAddressEqual, type Address, type Hash, type Hex } from 'viem'
import { publicKeyToAddress } from 'viem/accounts'
import type { FeePayerConfig } from './config.js'
import {
  finalizeFeePayerSignature,
  feePayerSigningPayload,
  InvalidExternalSignatureError,
} from './kaia-fee-payer-signature.js'

export type FeePayerSignerType = 'local-private-key' | 'aws-kms'
export type FeePayerSignerHealthStatus =
  | 'ready'
  | 'unavailable'
  | 'authentication_failure'
  | 'key_mismatch'
  | 'invalid_key'

export interface FeePayerSignerMetadata {
  readonly type: FeePayerSignerType
  readonly provider: 'process-local-kairos' | 'aws-kms'
  readonly keyReference: string
}

export interface FeePayerSigner {
  readonly address: Address
  readonly type: FeePayerSignerType
  readonly metadata: FeePayerSignerMetadata
  signAsFeePayer(request: FeePayerSigningRequest): Promise<FeePayerSigningResult>
  health(): Promise<FeePayerSignerHealth>
}

export interface FeePayerSigningRequest {
  readonly senderRaw: Hex
  readonly assertAssemblyAllowed?: () => void
}

export interface FeePayerSigningResult {
  readonly signedRaw: Hex
  readonly requestId?: string
}

export interface FeePayerSignerHealth {
  readonly status: FeePayerSignerHealthStatus
  readonly address: Address
  readonly type: FeePayerSignerType
  readonly metadata: FeePayerSignerMetadata
}

export type ExternalSignerErrorCode =
  | 'SIGNER_UNAVAILABLE'
  | 'SIGNER_TIMEOUT'
  | 'AUTHENTICATION_FAILURE'
  | 'SIGNING_FAILURE'
  | 'INVALID_SIGNATURE'
  | 'INVALID_KEY'
  | 'KEY_MISMATCH'

export class ExternalSignerError extends Error {
  override readonly name: string = 'ExternalSignerError'

  constructor(readonly code: ExternalSignerErrorCode) {
    super('External fee-payer signer failed safely')
  }
}

export class SignerUnavailableError extends ExternalSignerError {
  override readonly name = 'SignerUnavailableError'

  constructor() {
    super('SIGNER_UNAVAILABLE')
  }
}

export class SignerTimeoutError extends ExternalSignerError {
  override readonly name = 'SignerTimeoutError'

  constructor() {
    super('SIGNER_TIMEOUT')
  }
}

export interface ExternalSignerKey {
  readonly publicKeyDer: Uint8Array
  readonly keySpec: string
  readonly keyUsage: string
  readonly signingAlgorithms: readonly string[]
  readonly enabled: boolean
  readonly keyState: string
}

export interface ExternalSigningProvider {
  getKey(timeoutMs: number): Promise<ExternalSignerKey>
  signDigest(
    digest: Hash,
    timeoutMs: number,
  ): Promise<{ readonly derSignature: Uint8Array; readonly requestId?: string }>
}

export class LocalPrivateKeyFeePayerSigner implements FeePayerSigner {
  readonly address: Address
  readonly type = 'local-private-key' as const
  readonly metadata: FeePayerSignerMetadata = {
    type: 'local-private-key',
    provider: 'process-local-kairos',
    keyReference: 'kairos-development-only',
  }
  private readonly sign: (senderRaw: Hex) => Promise<Hex>

  constructor(config: FeePayerConfig) {
    if (
      config.networkId !== 'kairos' ||
      config.signerType !== 'local-private-key' ||
      config.localPrivateKey === null ||
      !config.profile.signingEnabled
    ) {
      throw new SignerUnavailableError()
    }

    const account = privateKeyToAccount(config.localPrivateKey)
    const wallet = createWalletClient({
      account,
      chain: config.profile.chain,
      transport: http(config.rpcUrl, { retryCount: 0, timeout: 10_000 }),
    })
    this.address = account.address
    this.sign = async (senderRaw) =>
      (await wallet.signTransactionAsFeePayer(senderRaw)) as Hex
  }

  async signAsFeePayer(
    request: FeePayerSigningRequest,
  ): Promise<FeePayerSigningResult> {
    return { signedRaw: await this.sign(request.senderRaw) }
  }

  async health(): Promise<FeePayerSignerHealth> {
    return {
      status: 'ready',
      address: this.address,
      type: this.type,
      metadata: this.metadata,
    }
  }
}

export class AwsKmsSigningProvider implements ExternalSigningProvider {
  private readonly client: KMSClient

  constructor(
    region: string,
    private readonly keyId: string,
    client?: KMSClient,
  ) {
    this.client = client ?? new KMSClient({ region, maxAttempts: 1 })
  }

  async getKey(timeoutMs: number): Promise<ExternalSignerKey> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const [description, publicKey] = await Promise.all([
        this.client.send(
          new DescribeKeyCommand({ KeyId: this.keyId }),
          { abortSignal: controller.signal },
        ),
        this.client.send(
          new GetPublicKeyCommand({ KeyId: this.keyId }),
          { abortSignal: controller.signal },
        ),
      ])
      if (publicKey.PublicKey === undefined) throw new SignerUnavailableError()
      return {
        publicKeyDer: publicKey.PublicKey,
        keySpec: publicKey.KeySpec ?? '',
        keyUsage: publicKey.KeyUsage ?? '',
        signingAlgorithms: publicKey.SigningAlgorithms ?? [],
        enabled: description.KeyMetadata?.Enabled === true,
        keyState: description.KeyMetadata?.KeyState ?? '',
      }
    } catch (error) {
      throw classifyProviderError(error)
    } finally {
      clearTimeout(timeout)
    }
  }

  async signDigest(
    digest: Hash,
    timeoutMs: number,
  ): Promise<{ readonly derSignature: Uint8Array; readonly requestId?: string }> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const result = await this.client.send(
        new SignCommand({
          KeyId: this.keyId,
          Message: Buffer.from(digest.slice(2), 'hex'),
          MessageType: 'DIGEST',
          SigningAlgorithm: 'ECDSA_SHA_256',
        }),
        { abortSignal: controller.signal },
      )
      if (result.Signature === undefined) {
        throw new ExternalSignerError('SIGNING_FAILURE')
      }
      return {
        derSignature: result.Signature,
        ...(result.$metadata.requestId === undefined
          ? {}
          : { requestId: result.$metadata.requestId }),
      }
    } catch (error) {
      throw classifyProviderError(error)
    } finally {
      clearTimeout(timeout)
    }
  }
}

export class AwsKmsFeePayerSigner implements FeePayerSigner {
  readonly type = 'aws-kms' as const
  readonly metadata: FeePayerSignerMetadata

  constructor(
    readonly address: Address,
    private readonly chainId: number,
    private readonly timeoutMs: number,
    private readonly provider: ExternalSigningProvider,
    keyReference: string,
  ) {
    this.address = getAddress(address)
    this.metadata = {
      type: 'aws-kms',
      provider: 'aws-kms',
      keyReference: safeKeyReference(keyReference),
    }
  }

  async health(): Promise<FeePayerSignerHealth> {
    try {
      await this.verifiedProviderAddress()
      return this.healthResult('ready')
    } catch (error) {
      return this.healthResult(healthStatus(error))
    }
  }

  async signAsFeePayer(
    request: FeePayerSigningRequest,
  ): Promise<FeePayerSigningResult> {
    await this.verifiedProviderAddress()
    const { digest } = feePayerSigningPayload(
      request.senderRaw,
      this.address,
      this.chainId,
    )
    let result: Awaited<ReturnType<ExternalSigningProvider['signDigest']>>
    request.assertAssemblyAllowed?.()
    try {
      result = await this.provider.signDigest(digest, this.timeoutMs)
    } catch (error) {
      throw classifyProviderError(error)
    }

    try {
      request.assertAssemblyAllowed?.()
      const finalized = await finalizeFeePayerSignature({
        senderRaw: request.senderRaw,
        feePayer: this.address,
        chainId: this.chainId,
        derSignature: result.derSignature,
      })
      return {
        signedRaw: finalized.signedRaw,
        ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
      }
    } catch (error) {
      if (error instanceof InvalidExternalSignatureError) {
        throw new ExternalSignerError('INVALID_SIGNATURE')
      }
      throw error
    }
  }

  private async verifiedProviderAddress(): Promise<Address> {
    let key: ExternalSignerKey
    try {
      key = await this.provider.getKey(this.timeoutMs)
    } catch (error) {
      throw classifyProviderError(error)
    }
    if (
      key.keySpec !== 'ECC_SECG_P256K1' ||
      key.keyUsage !== 'SIGN_VERIFY' ||
      !key.signingAlgorithms.includes('ECDSA_SHA_256') ||
      !key.enabled ||
      key.keyState !== 'Enabled'
    ) {
      throw new SignerUnavailableError()
    }

    let derived: Address
    try {
      derived = addressFromSpki(key.publicKeyDer)
    } catch {
      throw new ExternalSignerError('INVALID_KEY')
    }
    if (!isAddressEqual(derived, this.address)) {
      throw new ExternalSignerError('KEY_MISMATCH')
    }
    return derived
  }

  private healthResult(status: FeePayerSignerHealthStatus): FeePayerSignerHealth {
    return {
      status,
      address: this.address,
      type: this.type,
      metadata: this.metadata,
    }
  }
}

export function createFeePayerSigner(
  config: FeePayerConfig,
  provider?: ExternalSigningProvider,
): FeePayerSigner {
  if (config.networkId === 'kairos') {
    return new LocalPrivateKeyFeePayerSigner(config)
  }
  if (
    config.feePayerAddress === null ||
    config.mainnetSignerBackend !== 'aws-kms' ||
    config.awsKmsKeyId === null ||
    config.awsRegion === null
  ) {
    throw new SignerUnavailableError()
  }
  return new AwsKmsFeePayerSigner(
    config.feePayerAddress,
    config.chainId,
    config.signerTimeoutMs,
    provider ?? new AwsKmsSigningProvider(config.awsRegion, config.awsKmsKeyId),
    config.awsKmsKeyId,
  )
}

function addressFromSpki(publicKeyDer: Uint8Array): Address {
  const jwk = createPublicKey({
    key: Buffer.from(publicKeyDer),
    format: 'der',
    type: 'spki',
  }).export({ format: 'jwk' })
  if (jwk.kty !== 'EC' || jwk.crv !== 'secp256k1' || !jwk.x || !jwk.y) {
    throw new Error('Invalid external signer public key')
  }
  const x = Buffer.from(jwk.x, 'base64url')
  const y = Buffer.from(jwk.y, 'base64url')
  if (x.length !== 32 || y.length !== 32) {
    throw new Error('Invalid external signer public key')
  }
  return publicKeyToAddress(`0x04${x.toString('hex')}${y.toString('hex')}`)
}

function safeKeyReference(keyId: string): string {
  return `sha256:${createHash('sha256').update(keyId).digest('hex').slice(0, 16)}`
}

function classifyProviderError(error: unknown): ExternalSignerError {
  if (error instanceof ExternalSignerError) return error
  const name = error instanceof Error ? error.name : ''
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new SignerTimeoutError()
  }
  if (
    name === 'AccessDeniedException' ||
    name === 'UnrecognizedClientException' ||
    name === 'ExpiredTokenException' ||
    name === 'InvalidSignatureException'
  ) {
    return new ExternalSignerError('AUTHENTICATION_FAILURE')
  }
  if (
    name === 'DisabledException' ||
    name === 'KMSInvalidStateException' ||
    name === 'NotFoundException' ||
    name === 'DependencyTimeoutException' ||
    name === 'ThrottlingException'
  ) {
    return new SignerUnavailableError()
  }
  return new ExternalSignerError('SIGNING_FAILURE')
}

function healthStatus(error: unknown): FeePayerSignerHealthStatus {
  if (error instanceof ExternalSignerError) {
    switch (error.code) {
      case 'AUTHENTICATION_FAILURE':
        return 'authentication_failure'
      case 'KEY_MISMATCH':
        return 'key_mismatch'
      case 'INVALID_SIGNATURE':
      case 'INVALID_KEY':
        return 'invalid_key'
      default:
        return 'unavailable'
    }
  }
  return 'unavailable'
}
