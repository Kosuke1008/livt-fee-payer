import type { Address } from 'viem'

export interface MainnetPilotPolicy {
  readonly ready: boolean
  readonly diagnostics: readonly string[]
  readonly max_payment_jpyc: string
  readonly max_gas: string
  readonly max_gas_price_wei: string
  readonly rate_window_seconds: string
  readonly max_attempts_per_user: string
  readonly max_attempts_per_store: string
  readonly max_attempts_per_sender: string
  readonly max_attempts_global: string
  readonly daily_transaction_limit: string
  readonly daily_kaia_budget_wei: string
  readonly minimum_reserve_wei: string
  readonly maximum_balance_wei: string
  readonly merchant_address: string
  readonly sender_address: string
  readonly pilot_payment_id: string
}

// Only validated public policy values leave this parser. Invalid or absent
// pilot policy does not prevent Phase 11 read-only infrastructure readiness.
export function inspectMainnetPilotPolicy(
  environment: NodeJS.ProcessEnv,
  serviceMaxGas: bigint,
  minimumReserveWei: bigint,
  feePayerAddress: Address,
): MainnetPilotPolicy {
  const diagnostics: string[] = []
  const integer = (name: string, maximum = 18_446_744_073_709_551_615n): string => {
    const value = environment[name]
    if (value === undefined || !/^[1-9]\d{0,19}$/u.test(value) || BigInt(value) > maximum) {
      diagnostics.push(`INVALID_${name}`)
      return ''
    }
    return value
  }
  const one = (name: string): string => {
    if (environment[name] !== '1') {
      diagnostics.push(`INVALID_${name}`)
      return ''
    }
    return '1'
  }
  const kaia = (name: string): string => {
    const value = environment[name]
    if (value === undefined || !/^(0|[1-9]\d{0,59})(\.\d{1,18})?$/u.test(value)) {
      diagnostics.push(`INVALID_${name}`)
      return ''
    }
    const [whole = '0', fraction = ''] = value.split('.')
    const wei = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'))
    if (wei <= 0n || wei >= 2n ** 256n) {
      diagnostics.push(`INVALID_${name}`)
      return ''
    }
    return wei.toString()
  }
  const address = (name: string): string => {
    const value = environment[name]
    if (value === undefined || !/^0x[0-9a-fA-F]{40}$/u.test(value) || /^0x0{40}$/u.test(value)) {
      diagnostics.push(`INVALID_${name}`)
      return ''
    }
    return value.toLowerCase()
  }
  const fields = {
    max_payment_jpyc: one('SELF_HOSTED_MAINNET_MAX_PAYMENT_JPYC'),
    max_gas: integer('SELF_HOSTED_MAINNET_MAX_GAS'),
    max_gas_price_wei: integer('SELF_HOSTED_MAINNET_MAX_GAS_PRICE_WEI'),
    rate_window_seconds: integer('SELF_HOSTED_MAINNET_RATE_WINDOW_SECONDS', 86400n),
    max_attempts_per_user: one('SELF_HOSTED_MAINNET_MAX_ATTEMPTS_PER_USER'),
    max_attempts_per_store: one('SELF_HOSTED_MAINNET_MAX_ATTEMPTS_PER_STORE'),
    max_attempts_per_sender: one('SELF_HOSTED_MAINNET_MAX_ATTEMPTS_PER_SENDER'),
    max_attempts_global: one('SELF_HOSTED_MAINNET_MAX_ATTEMPTS_GLOBAL'),
    daily_transaction_limit: one('SELF_HOSTED_MAINNET_DAILY_TRANSACTION_LIMIT'),
    daily_kaia_budget_wei: kaia('SELF_HOSTED_MAINNET_DAILY_KAIA_BUDGET'),
    minimum_reserve_wei: minimumReserveWei > 0n ? minimumReserveWei.toString() : '',
    maximum_balance_wei: kaia('MAINNET_PILOT_MAX_FEE_PAYER_BALANCE_KAIA'),
    merchant_address: address('MAINNET_STAGING_MERCHANT_ADDRESS'),
    sender_address: address('MAINNET_STAGING_APPROVED_SENDER_ADDRESSES'),
    pilot_payment_id: integer('MAINNET_PILOT_PAYMENT_ID'),
  }
  if (fields.max_gas !== '' && BigInt(fields.max_gas) > 1_000_000n) {
    diagnostics.push('MAX_GAS_ABOVE_PILOT_CEILING')
  }
  if (fields.rate_window_seconds !== '' && BigInt(fields.rate_window_seconds) < 3600n) {
    diagnostics.push('RATE_WINDOW_BELOW_PILOT_MINIMUM')
  }
  if (minimumReserveWei <= 0n) diagnostics.push('INVALID_FEE_PAYER_MIN_RESERVE_KAIA')
  if (fields.max_gas !== '' && BigInt(fields.max_gas) !== serviceMaxGas) {
    diagnostics.push('FEE_PAYER_MAX_GAS_MISMATCH')
  }
  if (fields.max_gas !== '' && fields.max_gas_price_wei !== '') {
    const maximumFee = BigInt(fields.max_gas) * BigInt(fields.max_gas_price_wei)
    if (fields.daily_kaia_budget_wei !== '' && maximumFee > BigInt(fields.daily_kaia_budget_wei)) {
      diagnostics.push('DAILY_BUDGET_BELOW_MAXIMUM_FEE')
    }
    if (fields.maximum_balance_wei !== '' && maximumFee + minimumReserveWei > BigInt(fields.maximum_balance_wei)) {
      diagnostics.push('MAXIMUM_BALANCE_BELOW_FEE_PLUS_RESERVE')
    }
    if (fields.daily_kaia_budget_wei !== '' && fields.maximum_balance_wei !== '' &&
      BigInt(fields.daily_kaia_budget_wei) > BigInt(fields.maximum_balance_wei)) {
      diagnostics.push('DAILY_BUDGET_ABOVE_MAXIMUM_BALANCE')
    }
  }
  if (fields.merchant_address !== '' && fields.sender_address !== '' && (
    fields.merchant_address === fields.sender_address ||
    fields.merchant_address === feePayerAddress.toLowerCase() ||
    fields.sender_address === feePayerAddress.toLowerCase()
  )) diagnostics.push('PILOT_IDENTITIES_MUST_BE_DISTINCT')
  if (/^0x0{40}$/u.test(feePayerAddress)) diagnostics.push('INVALID_FEE_PAYER_ADDRESS')

  return { ready: diagnostics.length === 0, diagnostics, ...fields }
}
