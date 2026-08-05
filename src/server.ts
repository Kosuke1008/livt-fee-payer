import { loadConfig } from './config.js'
import { createFeePayerServer } from './http.js'
import {
  assertKairosReady,
  createSponsorDependencies,
  SponsorService,
} from './sponsor.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const dependencies = createSponsorDependencies(config)
  await assertKairosReady(config)

  const sponsorService = new SponsorService(config, dependencies)
  const server = createFeePayerServer({
    apiKey: config.apiKey,
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
      `LivT Fee Payer ready on ${config.host}:${config.port} (Kairos)\n`,
    )
  })
}

main().catch(() => {
  process.stderr.write('LivT Fee Payer failed to start safely\n')
  process.exitCode = 1
})
