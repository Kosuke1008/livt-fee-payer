import { loadConfig } from './config.js'
import { feePayerSigningPayload } from './kaia-fee-payer-signature.js'
import { createFeePayerSigner } from './signer.js'
import type { Hex } from 'viem'

// A Kairos fixture transaction. It is deliberately not a valid Mainnet JPYC
// payment and this command has no RPC/broadcast dependency.
const OFFLINE_SENDER_RAW = '0x31f8c50185066720b300830186a094e7c3d8c9a439fede00d2600032d5db0be71c3c298094a2a8854b1802d8cd5de631e690817c253d6a9153b844a9059cbb00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000de0b6b3a7640000f847f8458207f6a052baf55055acf5989c5fcae851e263f7a99bc2403210ebb4e70bcebc7945bed8a0755eadf37734c3f1629836ed938782dd1e40d4ece67910a84c2dafe234fe8c6d' as Hex

async function main(): Promise<void> {
  const config = loadConfig()
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
    config.feePayerAddress === null
  ) {
    throw new Error('Offline signer test requires all Mainnet gates disabled')
  }
  const signer = createFeePayerSigner(config)
  const health = await signer.health()
  if (health.status !== 'ready') throw new Error('External signer is not ready')

  const payload = feePayerSigningPayload(
    OFFLINE_SENDER_RAW,
    config.feePayerAddress,
    config.chainId,
  )
  await signer.signAsFeePayer({ senderRaw: OFFLINE_SENDER_RAW })
  process.stdout.write([
    'offline_signer_test=PASS',
    `signer_type=${signer.type}`,
    `key_reference=${signer.metadata.keyReference}`,
    `fee_payer_address=${signer.address}`,
    `test_digest=${payload.digest}`,
    'payment_touched=false',
    'broadcast_called=false',
    'mainnet_execution=disabled',
    '',
  ].join('\n'))
}

main().catch(() => {
  process.stderr.write('Offline Mainnet signer test failed safely (no broadcast)\n')
  process.exitCode = 1
})
