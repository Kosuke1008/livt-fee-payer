import {
  createWalletClient,
  http,
  kairos,
  privateKeyToAccount,
} from '@kaiachain/viem-ext'
import { getAddress, type Address, type Hex } from 'viem'

export const TOKEN = getAddress(
  '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29',
)
export const SENDER = getAddress(
  '0xa2a8854b1802d8cd5de631e690817c253d6a9153',
)
export const OTHER_ADDRESS = getAddress(
  '0x1111111111111111111111111111111111111111',
)
export const TEST_PRIVATE_KEY = `0x${'12'.repeat(32)}` as Hex

export const SENDER_RAW = '0x31f8c50185066720b300830186a094e7c3d8c9a439fede00d2600032d5db0be71c3c298094a2a8854b1802d8cd5de631e690817c253d6a9153b844a9059cbb00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000de0b6b3a7640000f847f8458207f6a052baf55055acf5989c5fcae851e263f7a99bc2403210ebb4e70bcebc7945bed8a0755eadf37734c3f1629836ed938782dd1e40d4ece67910a84c2dafe234fe8c6d' as Hex

export async function feePayerFixture(): Promise<{
  readonly address: Address
  readonly fullRaw: Hex
}> {
  const account = privateKeyToAccount(TEST_PRIVATE_KEY)
  const wallet = createWalletClient({
    account,
    chain: kairos,
    transport: http('https://rpc.invalid'),
  })
  const fullRaw = await wallet.signTransactionAsFeePayer(SENDER_RAW)
  return { address: account.address, fullRaw: fullRaw as Hex }
}
