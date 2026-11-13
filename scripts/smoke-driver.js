// Test-only Cordis plugin, mounted by scripts/smoke.mjs through a `--patch` overlay. Inside the booted dsh it creates
// one Agent and runs human command lines through the real `ctx.commands` registry (no model call), then writes the
// results to `config.out`. Directives: `@wait <ms>` pauses; `@fetch` GETs every http URL in the previous result.
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-plugin-smoke-driver'
export const inject = ['commands', 'agents']

export function apply(ctx, config) {
  let cancelled = false
  ctx.effect(() => () => { cancelled = true }, 'smoke-driver: cancel')
  void (async () => {
    const results = []
    try {
      await ctx.get('loader')?.await?.()
      const sessionId = `session-${randomUUID()}`
      const { agent } = await ctx.agents.create({
        sessionId,
        meta: { cwd: config.cwd },
        agentOptions: { provider: config.provider ?? 'deepseek-official', model: config.model ?? 'deepseek-flash' },
      })
      results.push({ line: '@agent', sessionId })
      for (const line of config.lines ?? []) {
        if (cancelled) break
        if (line.startsWith('@wait ')) {
          await new Promise(res => setTimeout(res, Number(line.slice(6))))
          continue
        }
        if (line === '@fetch') {
          const previous = results.at(-1)?.text ?? ''
          for (const url of previous.match(/https?:\/\/\S+/g) ?? []) {
            try {
              const resp = await fetch(url)
              const body = await resp.text()
              results.push({ line: `@fetch ${url}`, status: resp.status, bytes: body.length })
            } catch (error) {
              results.push({ line: `@fetch ${url}`, status: 0, error: String(error) })
            }
          }
          continue
        }
        const started = Date.now()
        const execution = await ctx.commands.execute(agent, line, [], AbortSignal.timeout(config.timeoutMs ?? 900000))
        results.push({ line, kind: execution?.result?.kind ?? 'unresolved', text: execution?.result?.text ?? '',
          ms: Date.now() - started })
      }
    } catch (error) {
      results.push({ line: '@driver-error', error: error instanceof Error ? error.stack : String(error) })
    }
    writeFileSync(config.out, JSON.stringify({ done: true, results }, null, 1))
  })()
}
