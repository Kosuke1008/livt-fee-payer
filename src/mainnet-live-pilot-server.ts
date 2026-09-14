import { loadConfig } from './config.js'
import { createFeePayerServer } from './http.js'
import { checkMainnetReadiness } from './readiness.js'
import { createFeePayerSigner } from './signer.js'
import { createSponsorDependencies, SponsorService } from './sponsor.js'
import { isKillSwitchActive } from './kill-switch.js'

async function main(): Promise<void> {
  const config = loadConfig()
  if (config.networkId !== 'kaia-mainnet' || !config.activationReleaseCapable) {
    throw new Error('Mainnet activation release capability is absent')
  }

  const signer = createFeePayerSigner(config)
  const runtimeLive = () => config.mainnetEnabled
    && config.selfHostedMainnetEnabled
    && config.mainnetSigningEnabled
    && config.mainnetBroadcastEnabled
    && !isKillSwitchActive(config.killSwitchActive)

  if (runtimeLive()) {
    if (config.profile.secondaryRpcUrl === null
      || config.pilotPolicy?.ready !== true) {
      throw new Error('Mainnet pilot RPC or policy is not ready')
    }
    const readiness = await checkMainnetReadiness(config, false)
    const health = await signer.health()
    if (health.status !== 'ready'
      || readiness.fundingStatus !== 'FUNDED'
      || readiness.balanceWei > BigInt(config.pilotPolicy.maximum_balance_wei)) {
      throw new Error('Mainnet pilot signer or funding is not ready')
    }
  }

  const unavailable = {
    sponsor: async (): Promise<never> => {
      throw new Error('Sponsorship is disabled')
    },
  }
  const sponsorService = runtimeLive()
    ? new SponsorService(config, createSponsorDependencies(config, signer))
    : unavailable

  const server = createFeePayerServer({
    apiKey: config.apiKey,
    networkId: config.networkId,
    feePayerAddress: signer.address,
    sponsorService,
    sponsorshipAvailable: runtimeLive,
    health: async () => {
      const readiness = await checkMainnetReadiness(config, false)
      const signerHealth = await signer.health()
      if (signerHealth.status !== 'ready') throw new Error('Signer not ready')
      return {
        status: 'READY',
        network: config.networkId,
        chain_id: config.chainId,
        fee_payer_address: readiness.feePayerAddress,
        balance_wei: readiness.balanceWei.toString(),
        balance_kaia: readiness.balanceKaia,
        minimum_reserve_wei: readiness.minimumReserveWei.toString(),
        funding_status: readiness.fundingStatus,
        pilot_policy: config.pilotPolicy,
        signer_status: signerHealth.status === 'ready' ? 'SIGNER_READY' : 'SIGNER_NOT_READY',
        signer_type: signerHealth.type,
        signer_key_reference: signerHealth.metadata.keyReference,
        activation_release_capable: true,
        execution: config.mainnetEnabled && config.selfHostedMainnetEnabled ? 'ENABLED' : 'DISABLED',
        signing: config.mainnetSigningEnabled ? 'ENABLED' : 'DISABLED',
        broadcast: config.mainnetBroadcastEnabled ? 'ENABLED' : 'DISABLED',
        kill_switch: isKillSwitchActive(config.killSwitchActive) ? 'ACTIVE' : 'INACTIVE',
      }
    },
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => server.close(() => process.exit(0)))
  }
  server.listen(config.port, config.host, () => {
    process.stdout.write(`Mainnet live-pilot service listening on ${config.host}:${config.port}\n`)
  })
}

main().catch(() => {
  process.stderr.write('Mainnet live-pilot service failed safely\n')
  process.exitCode = 1
})
