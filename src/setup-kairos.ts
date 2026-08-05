import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { privateKeyToAccount } from '@kaiachain/viem-ext'
import { generatePrivateKey } from 'viem/accounts'

async function main(): Promise<void> {
  const path = resolve(process.cwd(), '.env')
  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)

  let file
  try {
    file = await open(path, 'wx', 0o600)
    await file.writeFile(`FEE_PAYER_PRIVATE_KEY=${privateKey}\n`, {
      encoding: 'utf8',
    })
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new Error('Fee Payer .env already exists; it was not changed')
    }
    throw new Error('Could not create the Fee Payer environment', {
      cause: error,
    })
  } finally {
    await file?.close()
  }

  process.stdout.write(
    [
      'Kairos専用Fee Payerを作成しました。秘密鍵は.envだけに保存されています。',
      `Fee Payer公開アドレス: ${account.address}`,
      'この公開アドレスへKairos Faucetから必要最小限のKAIAを入れてください。',
      '',
    ].join('\n'),
  )
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === 'EEXIST'
  )
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Fee Payer setup failed'}\n`,
  )
  process.exitCode = 1
})
