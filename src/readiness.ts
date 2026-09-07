import { createPublicClient, http } from 'viem'
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
