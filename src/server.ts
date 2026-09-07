import { loadConfig } from './config.js'
import { createFeePayerServer } from './http.js'
import {
  createSponsorDependencies,
  SponsorService,
} from './sponsor.js'
import { assertFeePayerExecutionAllowed } from './network-profiles.js'
import {
  assertNetworkReady,
  shouldUseDevelopmentReadinessBypass,
} from './readiness.js'

async function main(): Promise<void> {
  const config = loadConfig()
  if (config.killSwitchActive) {
    throw new Error('Fee-payer kill switch is active')
  }
  assertFeePayerExecutionAllowed(config.profile)
  const dependencies = createSponsorDependencies(config)
  if (shouldUseDevelopmentReadinessBypass(config.profile, process.env)) {
    process.stdout.write(
      'Skipping Kairos readiness check (explicit development bypass)\n',
    )
  } else {
    await assertNetworkReady(config)
  }

  const sponsorService = new SponsorService(config, dependencies)
  const server = createFeePayerServer({
    apiKey: config.apiKey,
    networkId: config.networkId,
    feePayerAddress: dependencies.feePayerAddress,
    sponsorService,
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close(() => process.exit(0))
    })
  }

  server.listen(config.port, config.host, () => {
    process.stdout.write(
      `LivT Fee Payer ready on ${config.host}:${config.port} (${config.networkId})\n`,
    )
  })
}

main().catch(() => {
  process.stderr.write('LivT Fee Payer failed to start safely\n')
  process.exitCode = 1
})
