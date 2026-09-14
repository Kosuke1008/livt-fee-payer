import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  isMainnetActivationReleaseCapable,
  MAINNET_PILOT_RELEASE_ID,
} from '../src/activation-release.js'

test('activation capability is absent unless the exact reviewed artifact exists', () => {
  const directory = mkdtempSync(join(tmpdir(), 'livt-activation-'))
  const path = join(directory, 'manifest.json')
  assert.equal(isMainnetActivationReleaseCapable(path), false)
  writeFileSync(path, JSON.stringify({ release: 'wrong' }))
  assert.equal(isMainnetActivationReleaseCapable(path), false)
  writeFileSync(path, JSON.stringify({ release: MAINNET_PILOT_RELEASE_ID }))
  assert.equal(isMainnetActivationReleaseCapable(path), true)
  writeFileSync(path, JSON.stringify({ release: MAINNET_PILOT_RELEASE_ID, extra: true }))
  assert.equal(isMainnetActivationReleaseCapable(path), false)
})
