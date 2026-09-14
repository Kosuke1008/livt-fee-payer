import { loadConfig } from './config.js'
import { checkMainnetReadiness } from './readiness.js'
import { createFeePayerSigner } from './signer.js'

async function main(): Promise<void> {
  const config = loadConfig()

  const signerHealth = await createFeePayerSigner(config).health()
  if (signerHealth.status !== 'ready') {
    throw new Error('Mainnet external signer is not ready')
  }

  const report = await checkMainnetReadiness(config)
  process.stdout.write(
    [
      'network=kaia-mainnet',
      `chain_id=${config.chainId}`,
      `fee_payer_address=${report.feePayerAddress}`,
      `balance_wei=${report.balanceWei}`,
      `balance_kaia=${report.balanceKaia}`,
      `minimum_reserve_wei=${report.minimumReserveWei}`,
      `minimum_reserve_kaia=${report.minimumReserveKaia}`,
      `funding_status=${report.fundingStatus}`,
      `latest_block=${report.latestBlock}`,
      `secondary_latest_block=${report.secondaryLatestBlock ?? 'not-configured'}`,
      'kill_switch=active',
      `signer_type=${signerHealth.type}`,
      `signer_key_reference=${signerHealth.metadata.keyReference}`,
      'signer=SIGNER_READY',
      'execution=disabled',
      'signing=disabled',
      'broadcast=disabled',
      'readiness=READ_ONLY_READY',
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
