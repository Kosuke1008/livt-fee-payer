import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function isKillSwitchActive(
  configuredActive: boolean,
  emergencyFile = fileURLToPath(new URL('../mainnet-kill-switch', import.meta.url)),
): boolean {
  return configuredActive || existsSync(emergencyFile)
}
