import { loadConfig } from './config.js'
import { checkMainnetReadiness } from './readiness.js'
import { createFeePayerSigner } from './signer.js'

async function main(): Promise<void> {
  const config = loadConfig()

  const signerHealth = await createFeePayerSigner(config).health()
  if (signerHealth.status !== 'unavailable') {
    throw new Error('Mainnet signer must remain unavailable in Phase 8')
  }

  const report = await checkMainnetReadiness(config)
  process.stdout.write(
    [
      'network=kaia-mainnet',
      `chain_id=${config.chainId}`,
      `fee_payer_address=${report.feePayerAddress}`,
      `balance_kaia=${report.balanceKaia}`,
      `latest_block=${report.latestBlock}`,
      `secondary_latest_block=${report.secondaryLatestBlock ?? 'not-configured'}`,
      'kill_switch=active',
      'signer=structurally-configured-but-unavailable',
      'signing=disabled',
      'broadcast=disabled',
      'readiness=ready',
      '',
    ].join('\n'),
  )
}

main().catch(() => {
  process.stderr.write(
    'Mainnet Fee Payer readiness failed safely (no signing or broadcast)\n',
  )
  process.exitCode = 1
})
