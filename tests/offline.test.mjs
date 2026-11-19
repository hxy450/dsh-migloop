import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { commandTokens, offlineTarget } from '../lib/offline.js'
import { apply } from '../index.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'migloop offline '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'native session.jsonl')
  await writeFile(file, '{}\n')
  return { root, file }
}

test('quoted arguments preserve spaces and Windows backslashes', () => {
  assert.deepEqual(commandTokens(String.raw`serve --file "C:\offline sessions\native.jsonl"`), ['serve', '--file', String.raw`C:\offline sessions\native.jsonl`])
  assert.deepEqual(commandTokens("--file '/tmp/offline sessions/native.jsonl'"), ['--file', '/tmp/offline sessions/native.jsonl'])
})

test('explicit file input needs no persistence service or current agent', async t => {
  const { root, file } = await fixture(t)
  const target = offlineTarget(commandTokens(`--file "${file}" --sessions-root "${root}"`))
  assert.equal(target.path, file)
  assert.equal(target.root, root)
  assert.equal(target.offline, true)
  assert.equal(offlineTarget(['session-existing']), null)
})

test('bad file and sessions-root selections fail before launching Python', async t => {
  const { file } = await fixture(t)
  assert.throws(() => offlineTarget(['--file', 'relative.jsonl']), /absolute/)
  assert.throws(() => offlineTarget(['--file', file, '--sessions-root']), /sessions-root/)
  assert.throws(() => offlineTarget(['--file', file, '--sessions-root', file]), /directory/)
})

test('same-named exports from different directories have distinct service identities', async t => {
  const { root, file } = await fixture(t)
  await mkdir(join(root, 'other'))
  const other = join(root, 'other', 'native session.jsonl')
  await writeFile(other, '{}\n')
  assert.notEqual(offlineTarget(['--file', file]).id, offlineTarget(['--file', other]).id)
})

function command(persistence) {
  let definition
  apply({
    effect: effect => effect(),
    commands: { register(value) { definition = value; return () => {} } },
    inject() {},
    get: () => persistence,
  })
  return definition.handler
}

test('malformed quoted input returns a command error', async () => {
  const result = await command()({ rawInput: '--file "unterminated path' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Unterminated quoted argument/)
})

test('the existing list command still uses the persistence service', async () => {
  let calls = 0
  const handler = command({ async list() { calls++; return [] } })
  const result = await handler({ rawInput: 'list' })
  assert.equal(result.kind, 'success')
  assert.equal(calls, 1)
})
