import {
  type Address,
  type Hex,
} from 'viem'
import {
  NetworkProfileError,
  resolveNetworkProfile,
  type NetworkId,
  type NetworkProfile,
} from './network-profiles.js'
import { inspectMainnetPilotPolicy, type MainnetPilotPolicy } from './pilot-policy.js'
import { isMainnetActivationReleaseCapable } from './activation-release.js'

export interface FeePayerConfig {
  readonly host: '127.0.0.1'
  readonly port: number
  readonly apiKey: string
  readonly paymentAuthorizationKey: string | null
  readonly localPrivateKey: Hex | null
  readonly signerType: 'local-private-key' | 'external'
  readonly mainnetSignerBackend: 'aws-kms' | null
  readonly awsRegion: string | null
  readonly awsKmsKeyId: string | null
  readonly signerTimeoutMs: number
  readonly feePayerAddress: Address | null
  readonly kairosFeePayerAddress: Address | null
  readonly allowCrossNetworkIdentity: boolean
  readonly networkId: NetworkId
  readonly profileVersion: number
  readonly chainId: number
  readonly profile: NetworkProfile
  readonly rpcUrl: string
  readonly tokenContract: Address
  readonly maxGas: bigint
  readonly receiptTimeoutMs: number
  readonly killSwitchActive: boolean
  readonly minimumReserveWei: bigint
  readonly mainnetEnabled: boolean
  readonly selfHostedMainnetEnabled: boolean
  readonly mainnetSigningEnabled: boolean
  readonly mainnetBroadcastEnabled: boolean
  readonly pilotPolicy: MainnetPilotPolicy | null
  readonly activationReleaseCapable: boolean
}

export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError'
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  activationReleaseCapable = isMainnetActivationReleaseCapable(),
): FeePayerConfig {
  const apiKey = required(environment, 'FEE_PAYER_API_KEY')
  let profile: NetworkProfile
  try {
    profile = resolveNetworkProfile(environment, activationReleaseCapable)
  } catch (error) {
    if (error instanceof NetworkProfileError) {
      throw new ConfigurationError(error.message)
    }
    throw error
  }
  const localPrivateKey =
    profile.id === 'kairos'
      ? requiredEither(
          environment,
          'FEE_PAYER_KAIROS_PRIVATE_KEY',
          'FEE_PAYER_PRIVATE_KEY',
        )
      : null
  const signerType = profile.id === 'kairos'
    ? 'local-private-key'
    : externalSignerType(environment.FEE_PAYER_MAINNET_SIGNER_TYPE)
  const mainnetSignerBackend = profile.id === 'kaia-mainnet'
    ? externalSignerBackend(environment.FEE_PAYER_MAINNET_SIGNER_BACKEND)
    : null
  const awsRegion = profile.id === 'kaia-mainnet'
    ? awsRegionValue(environment.FEE_PAYER_AWS_REGION)
    : null
  const awsKmsKeyId = profile.id === 'kaia-mainnet'
    ? safeIdentifier(environment.FEE_PAYER_AWS_KMS_KEY_ID, 'AWS KMS key identifier')
    : null
  const feePayerAddress =
    profile.id === 'kaia-mainnet'
      ? address(environment.FEE_PAYER_KAIA_MAINNET_ADDRESS)
      : null
  const kairosFeePayerAddress =
    profile.id === 'kaia-mainnet'
      ? address(environment.FEE_PAYER_KAIROS_ADDRESS, 'Kairos fee-payer')
      : null
  const allowCrossNetworkIdentity = booleanFlag(
    environment.FEE_PAYER_ALLOW_CROSS_NETWORK_IDENTITY,
  )

  if (
    profile.id === 'kaia-mainnet' &&
    feePayerAddress?.toLowerCase() === kairosFeePayerAddress?.toLowerCase() &&
    !allowCrossNetworkIdentity
  ) {
    throw new ConfigurationError(
      'Kairos and Mainnet fee-payer identities must be distinct',
    )
  }

  if (apiKey.length < 32 || apiKey.length > 512 || /\s/u.test(apiKey)) {
    throw new ConfigurationError('Invalid internal API key configuration')
  }
  const paymentAuthorizationKey = profile.id === 'kaia-mainnet'
    ? authorizationKey(environment.MAINNET_PAYMENT_AUTHORIZATION_KEY)
    : null
  if (
    localPrivateKey !== null &&
    !/^0x[0-9a-fA-F]{64}$/u.test(localPrivateKey)
  ) {
    throw new ConfigurationError('Invalid fee-payer key configuration')
  }

  if (
    profile.id === 'kaia-mainnet' &&
    [
      environment.FEE_PAYER_PRIVATE_KEY,
      environment.FEE_PAYER_KAIROS_PRIVATE_KEY,
      environment.FEE_PAYER_KAIA_MAINNET_PRIVATE_KEY,
    ].some((value) => value !== undefined && value !== '')
  ) {
    throw new ConfigurationError(
      'Process-local Mainnet private keys are not supported',
    )
  }

  const mainnetEnabled = booleanFlag(environment.FEE_PAYER_MAINNET_ENABLED)
  const selfHostedMainnetEnabled = booleanFlag(
    environment.SELF_HOSTED_MAINNET_FEE_PAYER_ENABLED,
  )
  const mainnetSigningEnabled = booleanFlag(
    environment.FEE_PAYER_MAINNET_SIGNING_ENABLED,
  )
  const mainnetBroadcastEnabled = booleanFlag(
    environment.FEE_PAYER_MAINNET_BROADCAST_ENABLED,
  )
  const maxGas = positiveBigInt(environment.FEE_PAYER_MAX_GAS ?? '150000', 'maximum gas')
  const minimumReserveWei = decimalKaiaToWei(
    environment.FEE_PAYER_MIN_RESERVE_KAIA ?? (profile.id === 'kaia-mainnet' ? '' : '0'),
  )

  return {
    host: '127.0.0.1',
    port: integer(environment.FEE_PAYER_PORT ?? '19000', 1024, 65535),
    apiKey,
    paymentAuthorizationKey,
    localPrivateKey: localPrivateKey as Hex | null,
    signerType,
    mainnetSignerBackend,
    awsRegion,
    awsKmsKeyId,
    signerTimeoutMs: integer(
      environment.FEE_PAYER_SIGNER_TIMEOUT_MS ?? '5000',
      500,
      30_000,
    ),
    feePayerAddress,
    kairosFeePayerAddress,
    allowCrossNetworkIdentity,
    networkId: profile.id,
    profileVersion: profile.version,
    chainId: profile.chainId,
    profile,
    rpcUrl: profile.rpcUrl,
    tokenContract: profile.jpyc.contract,
    maxGas,
    receiptTimeoutMs: integer(
      environment.FEE_PAYER_RECEIPT_TIMEOUT_MS ?? '45000',
      1000,
      55000,
    ),
    killSwitchActive: booleanFlag(
      environment.FEE_PAYER_KILL_SWITCH,
      profile.id === 'kaia-mainnet',
    ),
    minimumReserveWei,
    mainnetEnabled,
    selfHostedMainnetEnabled,
    mainnetSigningEnabled,
    mainnetBroadcastEnabled,
    pilotPolicy: profile.id === 'kaia-mainnet' && feePayerAddress !== null
      ? inspectMainnetPilotPolicy(
          environment,
          maxGas,
          minimumReserveWei,
          feePayerAddress,
          paymentAuthorizationKey ?? '',
        )
      : null,
    activationReleaseCapable,
  }
}

function authorizationKey(value: string | undefined): string {
  if (value === undefined || !/^[0-9a-fA-F]{64}$/u.test(value)) {
    throw new ConfigurationError('Invalid Mainnet payment authorization key')
  }
  return value.toLowerCase()
}

function requiredEither(
  environment: NodeJS.ProcessEnv,
  preferredName: string,
  legacyName: string,
): string {
  const value = environment[preferredName] ?? environment[legacyName]
  if (typeof value !== 'string' || value === '') {
    throw new ConfigurationError(`Missing ${preferredName}`)
  }
  return value
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]
  if (typeof value !== 'string' || value === '') {
    throw new ConfigurationError(`Missing ${name}`)
  }
  return value
}

function integer(value: string, minimum: number, maximum: number): number {
  if (!/^\d+$/u.test(value)) {
    throw new ConfigurationError('Invalid numeric configuration')
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigurationError('Invalid numeric configuration')
  }
  return parsed
}

function positiveBigInt(value: string, label: string): bigint {
  if (!/^\d+$/u.test(value)) {
    throw new ConfigurationError(`Invalid ${label} configuration`)
  }
  const parsed = BigInt(value)
  if (parsed <= 0n || parsed > 18_446_744_073_709_551_615n) {
    throw new ConfigurationError(`Invalid ${label} configuration`)
  }
  return parsed
}

function booleanFlag(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new ConfigurationError('Invalid boolean configuration')
}

function address(
  value: string | undefined,
  label = 'Mainnet fee-payer',
): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/u.test(value)) {
    throw new ConfigurationError(`Invalid ${label} address`)
  }
  return value as Address
}

function externalSignerType(
  value: string | undefined,
): 'external' {
  if (value !== 'external') {
    throw new ConfigurationError(
      'Mainnet signer type must be external',
    )
  }
  return value
}

function externalSignerBackend(value: string | undefined): 'aws-kms' {
  if (value !== 'aws-kms') {
    throw new ConfigurationError('Mainnet signer backend must be aws-kms')
  }
  return value
}

function awsRegionValue(value: string | undefined): string {
  const region = safeIdentifier(value, 'AWS region')
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u.test(region)) {
    throw new ConfigurationError('Invalid AWS region configuration')
  }
  return region
}

function safeIdentifier(value: string | undefined, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 2048 ||
    /[\s\x00-\x1f\x7f]/u.test(value)
  ) {
    throw new ConfigurationError(`Invalid ${label} configuration`)
  }
  return value
}

function decimalKaiaToWei(value: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/u.test(value)) {
    throw new ConfigurationError('Invalid minimum reserve configuration')
  }
  const [whole = '', fraction = ''] = value.split('.')
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'))
}
