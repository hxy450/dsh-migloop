// dsh-migloop: view and analyse dsh Session trajectories with MigLoop's UI.
//
// /migloop [<session>]          render the MigLoop report (sub-agents included) for the current or a past Session
// /migloop serve [<session>]    start MigLoop's local server: report + time evidence tree + read-only atom endpoints
// /migloop stop [<session>]     stop servers started by this plugin
// /migloop list                 recent root Sessions of this dsh home
//
// The report is produced by the MigLoop zipapp (migloop-lineage.pyz) exactly as shipped; this plugin only finds the
// Session's log through dsh's persistence service and runs the Python toolchain.
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { pythonCommand, runPython, startServer, stopServer } from './lib/python.js'
import { listRootSessions, locateSession, targetOf } from './lib/sessions.js'

export const name = 'dsh-migloop'
export const inject = ['commands']

const HERE = dirname(fileURLToPath(import.meta.url))
const REPORT_ROUTE = '/api/dsh-migloop/report'
const SAFE_NAME = /^[\w.-]+\.html$/

export const Config = Schema.object({
  python: Schema.string().default('').description('Python executable (>= 3.11 for `serve`); empty: DSH_MIGLOOP_PYTHON, else `py -3` on Windows, `python3` elsewhere'),
  pythonArgs: Schema.array(Schema.string()).default([]).description('Arguments placed before the zipapp path'),
  migloopPyz: Schema.string().default('').description('Path to migloop-lineage.pyz; empty: vendor/migloop-lineage.pyz in this package'),
  outDir: Schema.string().default('').description('Where reports are written; empty: $DSH_HOME/migloop-reports'),
  serveHost: Schema.string().default('127.0.0.1').description('Bind address of `/migloop serve`'),
  timeoutMs: Schema.number().default(600000).description('Upper bound for one report run'),
})

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function settings(config) {
  return {
    python: pythonCommand(config),
    pyz: resolve(config.migloopPyz || join(HERE, 'vendor', 'migloop-lineage.pyz')),
    outDir: resolve(config.outDir || join(dshHome(), 'migloop-reports')),
    serveHost: config.serveHost || '127.0.0.1',
    timeoutMs: config.timeoutMs || 600000,
  }
}

function webUrl(path) {
  const base = process.env.DSH_WEB_URL
  return base ? new URL(path.replace(/^\//, ''), base.endsWith('/') ? base : `${base}/`).href : path
}

async function report(ctx, s, tokens, invocation) {
  const target = targetOf(tokens, invocation)
  const session = await locateSession(ctx.get('sessionPersistence'), target)
  if (!existsSync(s.pyz)) throw new Error(`MigLoop zipapp not found: ${s.pyz} (npm run build:migloop, or set migloopPyz)`)
  mkdirSync(s.outDir, { recursive: true })
  const short = session.id.replace(/^session-/, '').slice(0, 8)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
  const out = join(s.outDir, `migloop-${short}-${stamp}.html`)
  const run = await runPython(s.python, [s.pyz, session.path, '-o', out],
    { env: { DSH_SESSIONS_ROOT: session.root }, timeoutMs: s.timeoutMs, signal: invocation.signal })
  if (run.code !== 0 || !existsSync(out)) {
    throw new Error(`migloop exited with ${run.code}:\n${(run.stderr || run.stdout).slice(-1200)}`)
  }
  const summary = run.stdout.split(/\r?\n/).filter(l => /session|时长|已生成/.test(l)).join('\n')
  return [
    `MigLoop 报告已生成（Session ${session.id}）`,
    summary,
    `文件：${out}`,
    `本机打开：${pathToFileURL(out).href}`,
    ctx.get('connection') ? `Web：${webUrl(`${REPORT_ROUTE}?name=${encodeURIComponent(basename(out))}`)}` : '',
  ].filter(Boolean).join('\n')
}

async function serve(ctx, s, servers, tokens, invocation) {
  const target = targetOf(tokens, invocation)
  const session = await locateSession(ctx.get('sessionPersistence'), target)
  if (!existsSync(s.pyz)) throw new Error(`MigLoop zipapp not found: ${s.pyz}`)
  const running = servers.get(session.id)
  if (running && running.child.exitCode === null) return `已在运行：\n${running.urls.join('\n')}`
  const server = await startServer(s.python, [s.pyz, session.path, '--serve', '--host', s.serveHost, '--port', '0'],
    (out) => {
      const report = out.match(/报告页\s+(http\S+)/)
      const tree = out.match(/返修链路\s+(http\S+)/)
      return report && tree ? [report[1], tree[1]] : null
    }, { env: { DSH_SESSIONS_ROOT: session.root, MIGLOOP_CACHE_DIR: join(s.outDir, 'cache') } })
  const urls = [`报告页     ${server.ready[0]}`, `时间证据树 ${server.ready[1]}`]
  servers.set(session.id, { child: server.child, urls })
  server.child.on('close', () => { if (servers.get(session.id)?.child === server.child) servers.delete(session.id) })
  return `MigLoop 本机服务已启动（Session ${session.id}，/migloop stop 关闭）：\n${urls.join('\n')}`
}

function stop(servers, tokens) {
  const wanted = tokens.find(t => !t.startsWith('--'))
  const ids = [...servers.keys()].filter(id => !wanted || id === wanted || id.includes(wanted))
  for (const id of ids) {
    stopServer(servers.get(id).child)
    servers.delete(id)
  }
  return ids.length ? `已停止 ${ids.length} 个 MigLoop 服务：${ids.join(', ')}` : '没有由本插件启动的 MigLoop 服务'
}

async function list(ctx) {
  const rows = await listRootSessions(ctx.get('sessionPersistence'))
  if (!rows.length) return '这个 dsh home 里还没有落盘的根会话'
  return ['最近的根会话（子代理会话随根会话一起出现在报告里）：',
    ...rows.map(r => `${r.header.id}  ${new Date(r.header.createdAt).toISOString().slice(0, 16)}  ${r.header.cwd ?? ''}`),
  ].join('\n')
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config
 */
export function apply(ctx, config = {}) {
  const s = settings(config)
  const servers = new Map()
  ctx.effect(() => () => {
    for (const { child } of servers.values()) stopServer(child)
    servers.clear()
  }, 'dsh-migloop: servers')

  ctx.effect(() => ctx.commands.register({
    definitionId: 'dsh-migloop/migloop',
    name: 'migloop',
    description: 'MigLoop trajectory report / server for this or a past Session (list | serve | stop)',
    input: { hint: '[list | serve | stop] [session id or prefix]' },
    handler: async (invocation) => {
      const tokens = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
      const verb = ['list', 'serve', 'stop', 'report', 'help'].includes(tokens[0]) ? tokens.shift() : 'report'
      try {
        if (verb === 'help') {
          return { kind: 'success', text: '/migloop [会话] 生成报告；/migloop serve [会话] 起本机服务；/migloop stop；/migloop list' }
        }
        const text = verb === 'list' ? await list(ctx)
          : verb === 'serve' ? await serve(ctx, s, servers, tokens, invocation)
            : verb === 'stop' ? stop(servers, tokens)
              : await report(ctx, s, tokens, invocation)
        return { kind: 'success', text }
      } catch (error) {
        return { kind: 'error', text: `migloop: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }), 'dsh-migloop: /migloop')

  // On Web, reports are also served to the authenticated owner through the shared API channel.
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: REPORT_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const name = new URL(request.url).searchParams.get('name') ?? ''
        const file = join(s.outDir, name)
        if (!SAFE_NAME.test(name) || !existsSync(file) || !statSync(file).isFile()) {
          return new Response('not found', { status: 404 })
        }
        return new Response(readFileSync(file), {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
            'x-content-type-options': 'nosniff' },
        })
      },
    }), `dsh-migloop: ${REPORT_ROUTE}`)
  })
}
