import { kaia, kairos } from '@kaiachain/viem-ext'
import { isAddressEqual, type Address } from 'viem'

export type NetworkId = 'kairos' | 'kaia-mainnet'

const JPYC_CONTRACT =
  '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29' as Address

const PROFILE_DEFINITIONS = Object.freeze({
  kairos: Object.freeze({
    id: 'kairos',
    version: 1,
    chainId: 1001,
    chainIdHex: '0x3e9',
    chainName: 'Kaia Kairos',
    chain: kairos,
    explorerUrl: 'https://kairos.kaiascan.io',
    nativeCurrency: Object.freeze({ name: 'KAIA', symbol: 'KAIA', decimals: 18 }),
    isTestnet: true,
    jpyc: Object.freeze({
      contract: JPYC_CONTRACT,
      symbol: 'JPYC',
      decimals: 18,
    }),
    executionEnabled: true,
  }),
  'kaia-mainnet': Object.freeze({
    id: 'kaia-mainnet',
    version: 1,
    chainId: 8217,
    chainIdHex: '0x2019',
    chainName: 'Kaia Mainnet',
    chain: kaia,
    explorerUrl: 'https://kaiascan.io',
    nativeCurrency: Object.freeze({ name: 'KAIA', symbol: 'KAIA', decimals: 18 }),
    isTestnet: false,
    jpyc: Object.freeze({
      contract: JPYC_CONTRACT,
      symbol: 'JPYC',
      decimals: 18,
    }),
    // No Mainnet signer or broadcast adapter exists in Phase 1.
    executionEnabled: false,
  }),
} as const)

export type NetworkProfileDefinition =
  (typeof PROFILE_DEFINITIONS)[keyof typeof PROFILE_DEFINITIONS]

export type NetworkProfile = NetworkProfileDefinition & {
  readonly rpcUrl: string
}

export class NetworkProfileError extends Error {
  override readonly name = 'NetworkProfileError'
}

export class NetworkExecutionDisabledError extends Error {
  override readonly name = 'NetworkExecutionDisabledError'

  constructor(readonly networkId: NetworkId) {
    super(`Fee-payer execution is disabled for network: ${networkId}`)
  }
}

export function resolveNetworkProfile(
  environment: NodeJS.ProcessEnv,
): NetworkProfile {
  const networkId = environment.BLOCKCHAIN_NETWORK
  if (networkId !== 'kairos' && networkId !== 'kaia-mainnet') {
    throw new NetworkProfileError(
      'BLOCKCHAIN_NETWORK is missing, malformed, or unsupported',
    )
  }

  const definition = PROFILE_DEFINITIONS[networkId]
  const configuredRpc =
    networkId === 'kairos'
      ? environment.FEE_PAYER_KAIROS_RPC_URL ?? environment.KAIROS_RPC_URL
      : environment.FEE_PAYER_KAIA_MAINNET_RPC_URL
  const rpcUrl = resolveRpcUrl(configuredRpc, definition.chainName)

  const configuredChainId = environment.FEE_PAYER_CHAIN_ID
  if (
    configuredChainId !== undefined &&
    configuredChainId !== String(definition.chainId)
  ) {
    throw new NetworkProfileError('Configured chain ID does not match profile')
  }

  const configuredToken = environment.FEE_PAYER_TOKEN_CONTRACT
  if (
    configuredToken !== undefined &&
    (!/^0x[0-9a-fA-F]{40}$/u.test(configuredToken) ||
      !isAddressEqual(configuredToken as Address, definition.jpyc.contract))
  ) {
    throw new NetworkProfileError(
      'Configured token contract does not match the approved profile',
    )
  }

  validateBooleanFlag(
    environment.FEE_PAYER_MAINNET_ENABLED,
    'FEE_PAYER_MAINNET_ENABLED',
  )

  return Object.freeze({ ...definition, rpcUrl })
}

export function assertFeePayerExecutionAllowed(
  profile: NetworkProfile,
): void {
  if (!profile.executionEnabled) {
    throw new NetworkExecutionDisabledError(profile.id)
  }
}

function resolveRpcUrl(value: string | undefined, label: string): string {
  if (value === undefined || value === '') {
    throw new NetworkProfileError(`${label} RPC URL is missing`)
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new NetworkProfileError(`${label} RPC URL is invalid`)
  }

  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new NetworkProfileError(`${label} RPC URL is invalid`)
  }

  return url.href
}

function validateBooleanFlag(value: string | undefined, name: string): void {
  if (value !== undefined && value !== '' && value !== 'true' && value !== 'false') {
    throw new NetworkProfileError(`${name} must be true or false`)
  }
}
