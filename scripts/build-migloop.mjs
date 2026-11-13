// Build vendor/migloop-lineage.pyz from a MigLoop checkout that has the dsh adapter
// (fuxi-ailabs/migloop, branch feat/dsh-adapter until it is merged).
//
//   node scripts/build-migloop.mjs [<migloop checkout>]      (default: $MIGLOOP_SRC, else ../_migloop-dsh-1113)
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const checkout = resolve(process.argv[2] || process.env.MIGLOOP_SRC || join(here, '..', '_migloop-dsh-1113'))
const builder = join(checkout, 'scripts', 'build_pyz.py')
if (!existsSync(join(checkout, 'src', 'migloop', 'adapters', 'dsh.py'))) {
  console.error(`not a MigLoop checkout with the dsh adapter: ${checkout}`)
  process.exit(2)
}
const out = join(here, 'vendor', 'migloop-lineage.pyz')
mkdirSync(dirname(out), { recursive: true })
const python = process.env.DSH_MIGLOOP_PYTHON || (process.platform === 'win32' ? 'py' : 'python3')
const args = python === 'py' ? ['-3', builder, '-o', out] : [builder, '-o', out]
const run = spawnSync(python, args, { stdio: 'inherit', windowsHide: true })
process.exit(run.status ?? 1)
