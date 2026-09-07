import {
  createPublicClient,
  formatEther,
  http,
  type Address,
} from 'viem'
import type { FeePayerConfig } from './config.js'
import {
  NetworkProfileError,
  type NetworkProfile,
} from './network-profiles.js'

const tokenMetadataAbi = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
] as const

export async function assertNetworkReady(
  config: FeePayerConfig,
): Promise<void> {
  const publicClient = createPublicClient({
    chain: config.profile.chain,
    transport: http(config.rpcUrl, { retryCount: 0, timeout: 10_000 }),
  })
  const [chainId, bytecode, symbol, decimals] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBytecode({ address: config.tokenContract }),
    publicClient.readContract({
      abi: tokenMetadataAbi,
      address: config.tokenContract,
      functionName: 'symbol',
    }),
    publicClient.readContract({
      abi: tokenMetadataAbi,
      address: config.tokenContract,
      functionName: 'decimals',
    }),
  ])

  if (
    chainId !== config.chainId ||
    bytecode === undefined ||
    symbol !== config.profile.jpyc.symbol ||
    decimals !== config.profile.jpyc.decimals
  ) {
    throw new Error(`${config.profile.chainName} fee payer is not ready`)
  }
}

export interface MainnetReadinessResult {
  readonly ready: boolean
  readonly feePayerAddress: Address
  readonly balanceWei: bigint
  readonly balanceKaia: string
  readonly latestBlock: bigint
  readonly secondaryLatestBlock: bigint | null
}

export async function checkMainnetReadiness(
  config: FeePayerConfig,
): Promise<MainnetReadinessResult> {
  if (
    config.networkId !== 'kaia-mainnet' ||
    config.profile.executionEnabled ||
    config.profile.signingEnabled ||
    config.profile.broadcastEnabled ||
    config.mainnetEnabled ||
    config.selfHostedMainnetEnabled ||
    config.mainnetSigningEnabled ||
    config.mainnetBroadcastEnabled ||
    !config.killSwitchActive ||
    config.signerType !== 'external' ||
    config.feePayerAddress === null ||
    config.minimumReserveWei <= 0n
  ) {
    throw new NetworkProfileError(
      'Mainnet fee-payer readiness policy is not safely disabled',
    )
  }

  const primary = createPublicClient({
    chain: config.profile.chain,
    transport: http(config.rpcUrl, { retryCount: 0, timeout: 10_000 }),
  })
  const [chainId, bytecode, symbol, decimals, balanceWei, latestBlock] =
    await Promise.all([
      primary.getChainId(),
      primary.getBytecode({ address: config.tokenContract }),
      primary.readContract({
        abi: tokenMetadataAbi,
        address: config.tokenContract,
        functionName: 'symbol',
      }),
      primary.readContract({
        abi: tokenMetadataAbi,
        address: config.tokenContract,
        functionName: 'decimals',
      }),
      primary.getBalance({ address: config.feePayerAddress }),
      primary.getBlockNumber(),
    ])

  if (
    chainId !== config.profile.chainId ||
    bytecode === undefined ||
    symbol !== config.profile.jpyc.symbol ||
    decimals !== config.profile.jpyc.decimals ||
    balanceWei < config.minimumReserveWei
  ) {
    throw new NetworkProfileError('Mainnet fee-payer RPC readiness failed')
  }

  let secondaryLatestBlock: bigint | null = null
  if (config.profile.secondaryRpcUrl !== null) {
    const secondary = createPublicClient({
      chain: config.profile.chain,
      transport: http(config.profile.secondaryRpcUrl, {
        retryCount: 0,
        timeout: 10_000,
      }),
    })
    const [secondaryChainId, block] = await Promise.all([
      secondary.getChainId(),
      secondary.getBlockNumber(),
    ])
    if (secondaryChainId !== config.profile.chainId) {
      throw new NetworkProfileError('Secondary Mainnet RPC chain mismatch')
    }
    secondaryLatestBlock = block
  }

  return {
    ready: true,
    feePayerAddress: config.feePayerAddress,
    balanceWei,
    balanceKaia: formatEther(balanceWei),
    latestBlock,
    secondaryLatestBlock,
  }
}

export function shouldUseDevelopmentReadinessBypass(
  profile: NetworkProfile,
  environment: NodeJS.ProcessEnv,
): boolean {
  if (environment.FEE_PAYER_SKIP_KAIROS_CHECK !== '1') return false

  if (
    profile.id !== 'kairos' ||
    environment.NODE_ENV === 'production' ||
    environment.FEE_PAYER_DEVELOPMENT_BYPASS_ENABLED !== '1'
  ) {
    throw new NetworkProfileError(
      'Kairos readiness bypass is restricted to explicit non-production development',
    )
  }

  return true
}
