import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const output = resolve(process.cwd(), 'dist')
const expected = resolve(process.cwd(), 'dist')

if (output !== expected || output === resolve('/')) {
  throw new Error('Refusing to clean an unexpected build directory')
}

await rm(output, { recursive: true, force: true })
