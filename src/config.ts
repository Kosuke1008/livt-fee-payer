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

export interface FeePayerConfig {
  readonly host: '127.0.0.1'
  readonly port: number
  readonly apiKey: string
  readonly privateKey: Hex | null
  readonly networkId: NetworkId
  readonly profileVersion: number
  readonly chainId: number
  readonly profile: NetworkProfile
  readonly rpcUrl: string
  readonly tokenContract: Address
  readonly maxGas: bigint
  readonly receiptTimeoutMs: number
}

export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError'
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): FeePayerConfig {
  const apiKey = required(environment, 'FEE_PAYER_API_KEY')
  let profile: NetworkProfile
  try {
    profile = resolveNetworkProfile(environment)
  } catch (error) {
    if (error instanceof NetworkProfileError) {
      throw new ConfigurationError(error.message)
    }
    throw error
  }
  const privateKey =
    profile.id === 'kairos'
      ? requiredEither(
          environment,
          'FEE_PAYER_KAIROS_PRIVATE_KEY',
          'FEE_PAYER_PRIVATE_KEY',
        )
      : null

  if (apiKey.length < 32 || apiKey.length > 512 || /\s/u.test(apiKey)) {
    throw new ConfigurationError('Invalid internal API key configuration')
  }
  if (privateKey !== null && !/^0x[0-9a-fA-F]{64}$/u.test(privateKey)) {
    throw new ConfigurationError('Invalid fee-payer key configuration')
  }

  return {
    host: '127.0.0.1',
    port: integer(environment.FEE_PAYER_PORT ?? '19000', 1024, 65535),
    apiKey,
    privateKey: privateKey as Hex | null,
    networkId: profile.id,
    profileVersion: profile.version,
    chainId: profile.chainId,
    profile,
    rpcUrl: profile.rpcUrl,
    tokenContract: profile.jpyc.contract,
    maxGas: positiveBigInt(
      environment.FEE_PAYER_MAX_GAS ?? '150000',
      'maximum gas',
    ),
    receiptTimeoutMs: integer(
      environment.FEE_PAYER_RECEIPT_TIMEOUT_MS ?? '45000',
      1000,
      55000,
    ),
  }
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
