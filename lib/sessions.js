// Session lookup over dsh's own persistence service: ids, prefixes, the stored log file, roots.
import { dirname } from 'node:path'

/** `session-<uuid>` ids also match on the bare uuid. */
function matches(id, wanted) {
  return id === wanted || id.startsWith(wanted) || id.startsWith(`session-${wanted}`)
}

/**
 * The stored log of one Session, by exact id or unique prefix.
 * @param {any} persistence - `ctx.sessionPersistence` (dsh-session-persistence-jsonl in shipped profiles).
 * @param {string} wanted - Session id or prefix.
 * @returns {Promise<{id: string, path: string, header: any, root: string}>}
 */
export async function locateSession(persistence, wanted) {
  if (!persistence) throw new Error('this profile mounts no sessionPersistence service; cannot read Session logs')
  let snapshot = await persistence.stat(wanted).catch(() => undefined)
  if (!snapshot?.location) {
    const all = await persistence.list()
    const hits = all.filter(s => matches(String(s.header?.id ?? ''), wanted))
    if (hits.length > 1) throw new Error(`Session prefix "${wanted}" is ambiguous (${hits.length} Sessions)`)
    snapshot = hits[0]
  }
  if (!snapshot) throw new Error(`no stored Session matches "${wanted}"`)
  if (snapshot.location?.kind !== 'jsonl' || !snapshot.location.path) {
    throw new Error(`Session ${snapshot.header?.id} has no JSONL log on disk yet (unmaterialized, or another backend)`)
  }
  const path = snapshot.location.path
  // <root>/<project dir>/<session dir>/<generation file>
  return { id: String(snapshot.header.id), path, header: snapshot.header, root: dirname(dirname(dirname(path))) }
}

/**
 * Root Sessions (sub-agents excluded), newest first.
 * @param {any} persistence - `ctx.sessionPersistence`.
 * @param {number} limit - rows to return.
 */
export async function listRootSessions(persistence, limit = 15) {
  if (!persistence) throw new Error('this profile mounts no sessionPersistence service')
  const all = await persistence.list()
  return all
    .filter(s => s.header && !s.header.parentSession && s.location?.kind === 'jsonl')
    .sort((a, b) => (b.header.createdAt ?? 0) - (a.header.createdAt ?? 0))
    .slice(0, limit)
}

/** The Session id a command addresses: an explicit token, else the receiving agent's own Session. */
export function targetOf(tokens, invocation) {
  const explicit = tokens.find(t => !t.startsWith('--'))
  if (explicit) return explicit
  const own = invocation.agent?.session?.id ?? invocation.agent?.sessionId
  if (!own) throw new Error('no Session id given and the receiving agent exposes none')
  return String(own)
}
