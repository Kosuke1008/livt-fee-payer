export const BROADCAST_PROTOCOL_VERSION = 2 as const

export const BROADCAST_CERTAINTIES = [
  'definitely_not_broadcast',
  'broadcast_possible',
  'submitted',
] as const

export type BroadcastCertainty = typeof BROADCAST_CERTAINTIES[number]

export function isBroadcastCertainty(
  value: unknown,
): value is BroadcastCertainty {
  return typeof value === 'string'
    && BROADCAST_CERTAINTIES.includes(value as BroadcastCertainty)
}
