// Whether a user's dsh process is in the middle of a turn, so idle culling
// never stops a reply that is still running with no browser attached.

/**
 * Ask the child for its Session list; any Session with `running: true` means
 * busy. Errors count as busy: when in doubt, do not stop the process.
 * @param {{ port?: number, cookie?: string }} child
 * @returns {Promise<boolean>}
 */
export async function isBusy(child) {
  if (!child.port || !child.cookie) return false
  try {
    const res = await fetch(`http://127.0.0.1:${child.port}/api/session/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: child.cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: `gateway-busy-${Date.now()}`, method: 'session/list', payload: { args: { _request: {} } } }),
      signal: AbortSignal.timeout(5000),
    })
    const msg = await res.json()
    if (!msg?.result?.ok) return true
    return findRunning(msg.result.value)
  } catch {
    return true
  }
}

/** Walk the list answer for `running: true` without depending on its exact nesting. */
export function findRunning(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return false
  if (value.running === true) return true
  for (const v of Array.isArray(value) ? value : Object.values(value)) if (findRunning(v, depth + 1)) return true
  return false
}
