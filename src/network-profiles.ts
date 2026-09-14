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
    signingEnabled: true,
    broadcastEnabled: true,
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
    // Phase 9.5 keeps Mainnet execution/signing/broadcast structurally disabled.
    executionEnabled: false,
    signingEnabled: false,
    broadcastEnabled: false,
  }),
} as const)

export type NetworkProfileDefinition =
  (typeof PROFILE_DEFINITIONS)[keyof typeof PROFILE_DEFINITIONS]

export type NetworkProfile = NetworkProfileDefinition & {
  readonly rpcUrl: string
  readonly secondaryRpcUrl: string | null
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
  mainnetActivationReleaseCapable = false,
): NetworkProfile {
  const networkId = environment.BLOCKCHAIN_NETWORK
  if (networkId !== 'kairos' && networkId !== 'kaia-mainnet') {
    throw new NetworkProfileError(
      'BLOCKCHAIN_NETWORK is missing, malformed, or unsupported',
    )
  }

  const baseDefinition = PROFILE_DEFINITIONS[networkId]
  const definition = networkId === 'kaia-mainnet'
    ? Object.freeze({
        ...baseDefinition,
        executionEnabled: mainnetActivationReleaseCapable,
        signingEnabled: mainnetActivationReleaseCapable,
        broadcastEnabled: mainnetActivationReleaseCapable,
      })
    : baseDefinition
  const configuredRpc =
    networkId === 'kairos'
      ? environment.FEE_PAYER_KAIROS_RPC_URL ?? environment.KAIROS_RPC_URL
      : environment.FEE_PAYER_KAIA_MAINNET_RPC_URL
  const rpcUrl = resolveRpcUrl(configuredRpc, definition.chainName)
  const secondaryRpcUrl =
    networkId === 'kaia-mainnet' &&
    environment.FEE_PAYER_KAIA_MAINNET_SECONDARY_RPC_URL !== undefined
      ? resolveRpcUrl(
          environment.FEE_PAYER_KAIA_MAINNET_SECONDARY_RPC_URL,
          `${definition.chainName} secondary`,
        )
      : null

  if (networkId === 'kaia-mainnet') {
    assertMainnetRpcIsDedicated(rpcUrl)
    if (secondaryRpcUrl !== null) assertMainnetRpcIsDedicated(secondaryRpcUrl)
    if (secondaryRpcUrl === rpcUrl) {
      throw new NetworkProfileError(
        'Mainnet primary and secondary RPC URLs must be distinct',
      )
    }
  }

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

  return Object.freeze({
    ...definition,
    rpcUrl,
    secondaryRpcUrl,
  }) as unknown as NetworkProfile
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

function assertMainnetRpcIsDedicated(value: string): void {
  const host = new URL(value).hostname.toLowerCase()
  if (
    host === 'public-en.node.kaia.io' ||
    host === 'archive-en.node.kaia.io' ||
    host === 'public-en-kairos.node.kaia.io' ||
    host === 'archive-en-kairos.node.kaia.io'
  ) {
    throw new NetworkProfileError(
      'Kaia public Mainnet RPC is not permitted for the production profile',
    )
  }
}
