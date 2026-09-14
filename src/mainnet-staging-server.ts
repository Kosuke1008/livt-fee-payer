import { createServer } from 'node:http'
import { loadConfig } from './config.js'
import { checkMainnetReadiness } from './readiness.js'
import { createFeePayerSigner } from './signer.js'

async function main(): Promise<void> {
  const config = loadConfig()
  await checkMainnetReadiness(config)
  const signer = createFeePayerSigner(config)

  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')

    if (request.method === 'GET' && request.url === '/health') {
      try {
        const current = await checkMainnetReadiness(config)
        const signerHealth = await signer.health()
        response.writeHead(signerHealth.status === 'ready' ? 200 : 503)
        response.end(JSON.stringify({
          status: 'READ_ONLY_READY',
          network: config.networkId,
          chain_id: config.chainId,
          fee_payer_address: current.feePayerAddress,
          balance_wei: current.balanceWei.toString(),
          balance_kaia: current.balanceKaia,
          minimum_reserve_wei: current.minimumReserveWei.toString(),
          minimum_reserve_kaia: current.minimumReserveKaia,
          funding_status: current.fundingStatus,
          pilot_policy: config.pilotPolicy,
          activation_release_capable: config.activationReleaseCapable,
          signer_status: signerHealth.status === 'ready'
            ? 'SIGNER_READY'
            : 'SIGNER_NOT_READY',
          signer_type: signerHealth.type,
          signer_key_reference: signerHealth.metadata.keyReference,
          kill_switch: 'ACTIVE',
          execution: 'DISABLED',
          signing: 'DISABLED',
          broadcast: 'DISABLED',
        }))
      } catch {
        response.writeHead(503)
        response.end(JSON.stringify({ status: 'NOT_READY' }))
      }
      return
    }

    response.writeHead(404)
    response.end(JSON.stringify({ status: 'NOT_FOUND' }))
  })

  server.listen(config.port, config.host, () => {
    process.stdout.write(
      `Mainnet staging health listening on ${config.host}:${config.port}\n`,
    )
  })
}

main().catch(() => {
  process.stderr.write('Mainnet staging health failed safely\n')
  process.exitCode = 1
})
