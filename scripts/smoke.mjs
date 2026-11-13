// Smoke test: install this plugin into a throwaway dsh profile (copied from the shipped `sdk` template), boot that
// profile, and run /migloop through the real human-command registry. The SDK's own `session/query` dispatches only
// built-in commands, so a test-only driver plugin (scripts/smoke-driver.js, mounted with `--patch`) creates one Agent
// inside the booted dsh and calls `ctx.commands.execute` for each line. No model call is made.
//
//   node scripts/smoke.mjs --dsh <dsh bin.js | dsh> --session <migration id> [--session <repair id> ...] [--keep]
//
// Needs DSH_HOME pointing at the home that holds the recorded Sessions, pnpm on PATH (`dsh plugin` runs pnpm),
// Python >= 3.11, and vendor/migloop-lineage.pyz (npm run build:migloop).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const sessions = argv.flatMap((a, i) => (a === '--session' ? [argv[i + 1]] : []))
const dshBin = opt('--dsh') || 'dsh'
const keep = argv.includes('--keep')
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const profile = `smoke-migloop-${Date.now().toString(36)}`
const profileDir = join(home, 'profiles', profile)
const outDir = join(pluginDir, 'smoke-out', profile)
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${String(detail).replace(/\s+/g, ' ').slice(0, 220)}` : ''}`)
}
const yamlString = (s) => `'${String(s).replace(/'/g, "''")}'`

function dshArgs(args) {
  return dshBin.endsWith('.js') ? [process.execPath, [dshBin, ...args]] : [dshBin, args]
}

function dsh(args) {
  const [cmd, full] = dshArgs(args)
  return spawnSync(cmd, full, { encoding: 'utf8', windowsHide: true, shell: !dshBin.endsWith('.js') && process.platform === 'win32' })
}

async function runDriver(lines) {
  const out = join(outDir, 'driver-results.json')
  const overlay = join(outDir, 'driver.patch.yml')
  writeFileSync(overlay, [
    '- insert:',
    '    - id: dsh-plugin-smoke-driver',
    `      name: ${yamlString(join(pluginDir, 'scripts', 'smoke-driver.js').replace(/\\/g, '/'))}`,
    '      config:',
    `        out: ${yamlString(out)}`,
    `        cwd: ${yamlString(process.cwd())}`,
    '        lines:',
    ...lines.map(l => `          - ${yamlString(l)}`),
    '',
  ].join('\n'))
  const [cmd, full] = dshArgs(['--profile', profile, '--patch', overlay])
  const child = spawn(cmd, full, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    shell: !dshBin.endsWith('.js') && process.platform === 'win32' })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  child.stdout.on('data', () => {})
  const deadline = Date.now() + 20 * 60 * 1000
  while (Date.now() < deadline && child.exitCode === null) {
    if (existsSync(out)) break
    await new Promise(res => setTimeout(res, 500))
  }
  child.stdin.end()                                   // the SDK runtime stops when its client disconnects
  await new Promise(res => { if (child.exitCode !== null) res(); else { child.on('close', res); setTimeout(res, 15000) } })
  if (child.exitCode === null) child.kill()
  if (!existsSync(out)) throw new Error(`driver produced no results; stderr:\n${stderr.slice(-3000)}`)
  return { report: JSON.parse(readFileSync(out, 'utf8')).results, stderr }
}

async function main() {
  if (!sessions.length) throw new Error('give at least one --session <id> of a recorded dsh Session')
  mkdirSync(outDir, { recursive: true })
  check('vendor zipapp present', existsSync(join(pluginDir, 'vendor', 'migloop-lineage.pyz')), 'npm run build:migloop')
  let r = dsh(['--profile', profile, '--from-default-profile', 'sdk', '--dump-config'])
  check('throwaway profile from the sdk template', r.status === 0 && existsSync(profileDir), profileDir)
  r = dsh(['plugin', '--profile', profile, 'add', pluginDir])
  check('dsh plugin add <this package>', r.status === 0, `exit ${r.status}`)
  r = dsh(['--profile', profile, '--dump-config'])
  check('composed tree has the dsh-migloop layer', r.status === 0 && /# == dsh-migloop/.test(r.stdout) && /id: dsh-migloop/.test(r.stdout))
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  check('profile bundles list it', manifest.dsh?.profile?.bundles?.includes('dsh-migloop'), JSON.stringify(manifest.dsh?.profile?.bundles))

  const lines = ['/migloop help', '/migloop list', ...sessions.map(s => `/migloop ${s}`),
    `/migloop serve ${sessions[0]}`, '@fetch', '/migloop stop', '/migloop no-such-session', '@wait 7000', '/migloop']
  const { report, stderr } = await runDriver(lines)
  writeFileSync(join(outDir, 'stderr.txt'), stderr)
  const at = (line) => report.find(x => x.line === line)
  check('driver agent created inside dsh', Boolean(at('@agent')), at('@agent')?.sessionId ?? report.at(-1)?.error)
  check('/migloop help', at('/migloop help')?.kind === 'success', at('/migloop help')?.text)
  const listed = at('/migloop list')
  check('/migloop list', listed?.kind === 'success' && sessions.every(s => listed.text.includes(s)), listed?.text?.split('\n')[1])
  for (const sid of sessions) {
    const res = at(`/migloop ${sid}`)
    const file = res?.text?.match(/文件：(.+)/)?.[1]?.trim()
    const html = file && existsSync(file) ? readFileSync(file, 'utf8') : ''
    check(`/migloop ${sid}`, res?.kind === 'success' && /"session_format": ?"dsh"/.test(html) && html.includes('DeepSeek Harness'),
      `${res?.ms ?? '?'} ms · ${file ?? res?.text}`)
  }
  const served = at(`/migloop serve ${sessions[0]}`)
  check('/migloop serve', served?.kind === 'success' && (served.text.match(/http:\/\//g) ?? []).length === 2, served?.text)
  const fetches = report.filter(x => x.line.startsWith('@fetch '))
  check('served pages answer 200 (report + time evidence tree)', fetches.length === 2 && fetches.every(f => f.status === 200 && f.bytes > 1000),
    fetches.map(f => `${f.status} ${f.bytes}B ${f.line.slice(7)}`).join(' | '))
  check('/migloop stop', at('/migloop stop')?.kind === 'success' && /已停止 1/.test(at('/migloop stop').text), at('/migloop stop')?.text)
  check('/migloop <unknown> is an error result', at('/migloop no-such-session')?.kind === 'error', at('/migloop no-such-session')?.text)
  const own = at('/migloop')
  const ownFile = own?.text?.match(/文件：(.+)/)?.[1]?.trim()
  check('/migloop on the receiving (current) Session', own?.kind === 'success' && ownFile && existsSync(ownFile),
    own?.text?.split('\n')[0])
  if (!keep) {
    rmSync(profileDir, { recursive: true, force: true })
    check('throwaway profile removed', !existsSync(profileDir))
  }
  const failed = results.filter(x => !x.ok)
  writeFileSync(join(outDir, 'smoke-summary.json'), JSON.stringify({ profile, results, driver: report }, null, 1))
  console.log(JSON.stringify({ profile, passed: results.length - failed.length, failed: failed.length, out: outDir }, null, 1))
  process.exit(failed.length ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
