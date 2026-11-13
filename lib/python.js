// Running the shipped Python toolchain (one-shot commands and long-lived local servers).
import { spawn } from 'node:child_process'

/** Interpreter and leading arguments: config first, then DSH_MIGLOOP_PYTHON, then `py -3` / `python3`. */
export function pythonCommand(config) {
  if (config.python) return { cmd: config.python, args: [...(config.pythonArgs ?? [])] }
  if (process.env.DSH_MIGLOOP_PYTHON) return { cmd: process.env.DSH_MIGLOOP_PYTHON, args: [] }
  return process.platform === 'win32' ? { cmd: 'py', args: ['-3'] } : { cmd: 'python3', args: [] }
}

function childEnv(extra) {
  return { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', ...extra }
}

/**
 * Run one Python command to completion.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function runPython(python, args, { env = {}, cwd, timeoutMs = 600000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python.cmd, [...python.args, ...args], { cwd, env: childEnv(env), windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    const abort = () => child.kill()
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * Start a long-lived Python server and resolve once `ready(line)` returns a value from its stdout.
 * @returns {Promise<{child: import('node:child_process').ChildProcess, ready: any, output: () => string}>}
 */
export function startServer(python, args, ready, { env = {}, cwd, timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python.cmd, [...python.args, ...args], { cwd, env: childEnv(env), windowsHide: true })
    let out = ''
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      reject(err)
    }
    const timer = setTimeout(() => fail(new Error(`server did not report readiness in ${timeoutMs} ms:\n${out.slice(-1500)}`)),
      timeoutMs)
    const onData = (d) => {
      out += d
      if (settled) return
      const value = ready(out)
      if (value) {
        settled = true
        clearTimeout(timer)
        resolve({ child, ready: value, output: () => out })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', fail)
    child.on('close', code => fail(new Error(`server exited with code ${code}:\n${out.slice(-1500)}`)))
  })
}

/** Stop a server child (its whole tree on Windows). */
export function stopServer(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  else child.kill()
}
