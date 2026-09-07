import { createWalletClient, privateKeyToAccount } from '@kaiachain/viem-ext'
import { http, type Address, type Hex } from 'viem'
import type { FeePayerConfig } from './config.js'

export interface FeePayerSigner {
  readonly address: Address
  signAsFeePayer(request: FeePayerSigningRequest): Promise<FeePayerSigningResult>
  health(): Promise<FeePayerSignerHealth>
}

export interface FeePayerSigningRequest {
  readonly senderRaw: Hex
}

export interface FeePayerSigningResult {
  readonly signedRaw: Hex
}

export interface FeePayerSignerHealth {
  readonly status: 'ready' | 'unavailable'
  readonly address: Address
}

export class SignerUnavailableError extends Error {
  override readonly name = 'SignerUnavailableError'

  constructor() {
    super('Fee-payer signer is unavailable')
  }
}

export class SignerTimeoutError extends Error {
  override readonly name = 'SignerTimeoutError'

  constructor() {
    super('Fee-payer signer timed out')
  }
}

export class LocalPrivateKeyFeePayerSigner implements FeePayerSigner {
  readonly address: Address
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
    return { status: 'ready', address: this.address }
  }
}

export class UnavailableExternalFeePayerSigner implements FeePayerSigner {
  constructor(readonly address: Address) {}

  async signAsFeePayer(): Promise<FeePayerSigningResult> {
    throw new SignerUnavailableError()
  }

  async health(): Promise<FeePayerSignerHealth> {
    return { status: 'unavailable', address: this.address }
  }
}

export function createFeePayerSigner(config: FeePayerConfig): FeePayerSigner {
  if (config.networkId === 'kairos') {
    return new LocalPrivateKeyFeePayerSigner(config)
  }

  if (config.feePayerAddress === null) throw new SignerUnavailableError()

  // Phase 9 exposes structural health without providing any Mainnet signing
  // capability. A future adapter can implement this interface unchanged.
  return new UnavailableExternalFeePayerSigner(config.feePayerAddress)
}
