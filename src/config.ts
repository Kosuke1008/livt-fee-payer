import {
  getAddress,
  type Address,
  type Hex,
} from 'viem'

export interface FeePayerConfig {
  readonly host: '127.0.0.1'
  readonly port: number
  readonly apiKey: string
  readonly privateKey: Hex
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
  const privateKey = required(environment, 'FEE_PAYER_PRIVATE_KEY')
  const rpcUrl = required(environment, 'KAIROS_RPC_URL')
  const token = required(environment, 'FEE_PAYER_TOKEN_CONTRACT')

  if (apiKey.length < 32 || apiKey.length > 512 || /\s/u.test(apiKey)) {
    throw new ConfigurationError('Invalid internal API key configuration')
  }
  if (!/^0x[0-9a-fA-F]{64}$/u.test(privateKey)) {
    throw new ConfigurationError('Invalid fee-payer key configuration')
  }

  let parsedRpcUrl: URL
  try {
    parsedRpcUrl = new URL(rpcUrl)
  } catch {
    throw new ConfigurationError('Invalid Kairos RPC configuration')
  }
  if (
    parsedRpcUrl.protocol !== 'https:' ||
    parsedRpcUrl.username !== '' ||
    parsedRpcUrl.password !== '' ||
    parsedRpcUrl.search !== '' ||
    parsedRpcUrl.hash !== ''
  ) {
    throw new ConfigurationError('Invalid Kairos RPC configuration')
  }

  let tokenContract: Address
  try {
    tokenContract = getAddress(token)
  } catch {
    throw new ConfigurationError('Invalid token policy configuration')
  }

  return {
    host: '127.0.0.1',
    port: integer(environment.FEE_PAYER_PORT ?? '19000', 1024, 65535),
    apiKey,
    privateKey: privateKey as Hex,
    rpcUrl: parsedRpcUrl.href,
    tokenContract,
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
