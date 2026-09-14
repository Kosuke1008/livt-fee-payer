import {
  getChainIdFromSignatureTuples,
  parseTransaction,
  TxType,
} from '@kaiachain/viem-ext'
import {
  getAddress,
  isAddressEqual,
  isHex,
  type Address,
  type Hex,
} from 'viem'

const TRANSFER_SELECTOR = '0xa9059cbb'
const MAX_RAW_LENGTH = 20_000

export type TransactionPolicyCode =
  | 'INVALID_SENDER_TRANSACTION'
  | 'WRONG_TRANSACTION_TYPE'
  | 'ALREADY_FEE_PAYER_SIGNED'
  | 'WRONG_TOKEN'
  | 'NONZERO_VALUE'
  | 'GAS_OUT_OF_POLICY'
  | 'INVALID_TRANSFER_CALLDATA'
  | 'INVALID_SENDER_SIGNATURE'
  | 'WRONG_CHAIN'
  | 'INVALID_TRANSFER_DATA'
  | 'INVALID_FEE_PAYER_TRANSACTION'
  | 'SENDER_FIELDS_CHANGED'
  | 'WRONG_FEE_PAYER'
  | 'INVALID_FEE_PAYER_SIGNATURE'
  | 'SENDER_SIGNATURE_MISMATCH'
  | 'INVALID_ADDRESS'
  | 'INVALID_QUANTITY'
  | 'REQUEST_TOO_LARGE'

export class TransactionPolicyError extends Error {
  override readonly name = 'TransactionPolicyError'

  constructor(readonly code: TransactionPolicyCode) {
    super('Transaction rejected by fee policy')
  }
}

export interface ValidatedSenderTransaction {
  readonly raw: Hex
  readonly sender: Address
  readonly tokenContract: Address
  readonly gasLimit: bigint
  readonly gasPrice: bigint
  readonly recipient: Address
  readonly atomicAmount: bigint
  readonly data: Hex
  readonly transaction: Record<string, unknown>
}

export function validateSenderTransaction(
  raw: unknown,
  tokenContract: Address,
  maxGas: bigint,
  expectedChainId: number,
): ValidatedSenderTransaction {
  if (
    typeof raw !== 'string' ||
    !isHex(raw) ||
    raw.length < 4 ||
    raw.length > MAX_RAW_LENGTH ||
    raw.slice(0, 4).toLowerCase() !== '0x31'
  ) {
    throw new TransactionPolicyError('INVALID_SENDER_TRANSACTION')
  }

  let transaction: Record<string, unknown>
  try {
    transaction = parseTransaction(raw) as unknown as Record<string, unknown>
  } catch {
    throw new TransactionPolicyError('INVALID_SENDER_TRANSACTION')
  }

  const sender = address(transaction.from)
  const to = address(transaction.to)
  const gasLimit = quantity(transaction.gasLimit)
  const gasPrice = quantity(transaction.gasPrice)
  const value = quantity(transaction.value)
  const data = transaction.data
  const signatures = transaction.txSignatures

  if (transaction.type !== TxType.FeeDelegatedSmartContractExecution) {
    throw new TransactionPolicyError('WRONG_TRANSACTION_TYPE')
  }
  if (
    transaction.feePayer !== undefined ||
    transaction.feePayerSignatures !== undefined
  ) {
    throw new TransactionPolicyError('ALREADY_FEE_PAYER_SIGNED')
  }
  if (!isAddressEqual(to, tokenContract)) {
    throw new TransactionPolicyError('WRONG_TOKEN')
  }
  if (value !== 0n) throw new TransactionPolicyError('NONZERO_VALUE')
  if (gasLimit <= 0n || gasLimit > maxGas) {
    throw new TransactionPolicyError('GAS_OUT_OF_POLICY')
  }
  if (
    !isHex(data) ||
    data.length !== 138 ||
    data.slice(0, 10).toLowerCase() !== TRANSFER_SELECTOR
  ) {
    throw new TransactionPolicyError('INVALID_TRANSFER_CALLDATA')
  }
  if (!Array.isArray(signatures) || signatures.length !== 1) {
    throw new TransactionPolicyError('INVALID_SENDER_SIGNATURE')
  }
  if (getChainId(signatures) !== expectedChainId) {
    throw new TransactionPolicyError('WRONG_CHAIN')
  }

  const recipientWord = data.slice(10, 74)
  const amountWord = data.slice(74, 138)
  if (
    !/^0{24}[0-9a-fA-F]{40}$/u.test(recipientWord) ||
    BigInt(`0x${amountWord}`) <= 0n
  ) {
    throw new TransactionPolicyError('INVALID_TRANSFER_DATA')
  }

  return {
    raw: raw.toLowerCase() as Hex,
    sender,
    tokenContract: to,
    gasLimit,
    gasPrice,
    recipient: address(`0x${recipientWord.slice(-40)}`),
    atomicAmount: BigInt(`0x${amountWord}`),
    data,
    transaction,
  }
}

export function validateFeePayerTransaction(
  fullRaw: unknown,
  sender: ValidatedSenderTransaction,
  feePayer: Address,
  expectedChainId: number,
): Hex {
  if (typeof fullRaw !== 'string' || !isHex(fullRaw)) {
    throw new TransactionPolicyError('INVALID_FEE_PAYER_TRANSACTION')
  }

  let full: Record<string, unknown>
  try {
    full = parseTransaction(fullRaw) as unknown as Record<string, unknown>
  } catch {
    throw new TransactionPolicyError('INVALID_FEE_PAYER_TRANSACTION')
  }

  const preservedFields = [
    'type',
    'nonce',
    'gasLimit',
    'gasPrice',
    'to',
    'value',
    'from',
    'data',
    'txSignatures',
  ] as const

  if (
    preservedFields.some(
      (field) => canonical(full[field]) !== canonical(sender.transaction[field]),
    )
  ) {
    throw new TransactionPolicyError('SENDER_FIELDS_CHANGED')
  }
  if (!isAddressEqual(address(full.feePayer), feePayer)) {
    throw new TransactionPolicyError('WRONG_FEE_PAYER')
  }
  if (
    !Array.isArray(full.feePayerSignatures) ||
    full.feePayerSignatures.length !== 1
  ) {
    throw new TransactionPolicyError('INVALID_FEE_PAYER_SIGNATURE')
  }
  if (getChainId(full.feePayerSignatures) !== expectedChainId) {
    throw new TransactionPolicyError('WRONG_CHAIN')
  }

  return fullRaw
}

function address(value: unknown): Address {
  if (typeof value !== 'string') {
    throw new TransactionPolicyError('INVALID_ADDRESS')
  }
  try {
    return getAddress(value)
  } catch {
    throw new TransactionPolicyError('INVALID_ADDRESS')
  }
}

function quantity(value: unknown): bigint {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    (typeof value === 'number' && !Number.isSafeInteger(value))
  ) {
    throw new TransactionPolicyError('INVALID_QUANTITY')
  }
  try {
    return BigInt(value)
  } catch {
    throw new TransactionPolicyError('INVALID_QUANTITY')
  }
}

function getChainId(signatures: unknown[]): number {
  try {
    const chainId = getChainIdFromSignatureTuples(signatures)
    if (chainId === undefined) {
      throw new TransactionPolicyError('INVALID_SENDER_SIGNATURE')
    }
    return chainId
  } catch {
    throw new TransactionPolicyError('INVALID_SENDER_SIGNATURE')
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, nested) =>
    typeof nested === 'bigint' ? nested.toString() : nested,
  )
}
