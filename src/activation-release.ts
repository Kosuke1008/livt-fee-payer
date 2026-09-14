import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const MAINNET_PILOT_RELEASE_ID = 'phase-13-mainnet-pilot-v1'

export function isMainnetActivationReleaseCapable(
  manifestPath = fileURLToPath(
    new URL('../mainnet-pilot-activation.json', import.meta.url),
  ),
): boolean {
  try {
    const value = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
    return typeof value === 'object' && value !== null
      && Object.keys(value).length === 1
      && Reflect.get(value, 'release') === MAINNET_PILOT_RELEASE_ID
  } catch {
    return false
  }
}
