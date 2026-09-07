import { createServer } from 'node:http'
import { loadConfig } from './config.js'
import { checkMainnetReadiness } from './readiness.js'
import { createFeePayerSigner } from './signer.js'

async function main(): Promise<void> {
  const config = loadConfig()
  await checkMainnetReadiness(config)
  const signer = await createFeePayerSigner(config).health()

  if (signer.status !== 'unavailable') {
    throw new Error('Mainnet staging signer must remain unavailable')
  }

  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')

    if (request.method === 'GET' && request.url === '/health') {
      try {
        const current = await checkMainnetReadiness(config)
        response.writeHead(200)
        response.end(JSON.stringify({
          status: 'STRUCTURALLY_READY',
          network: config.networkId,
          chain_id: config.chainId,
          fee_payer_address: current.feePayerAddress,
          balance_kaia: current.balanceKaia,
          signer_status: 'UNAVAILABLE',
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
      `Mainnet staging read-only health listening on ${config.host}:${config.port}\n`,
    )
  })
}

main().catch(() => {
  process.stderr.write('Mainnet staging health failed safely\n')
  process.exitCode = 1
})
