/**
 * Session isolation — Host-only bundle plugin.
 *
 * Every session that enters one of the configured workspaces while it is still
 * at that workspace's root — a brand-new session, a cleared one, or an existing
 * session resumed for the first time — is switched to its own working directory
 * at `<workspace>/<baseDir>/<session-id>`, while the session keeps belonging to
 * the workspace itself: `SessionHeader.cwd` is not touched, only the
 * `working-directory` Session projection is changed.
 *
 * The plugin also answers one read-only HTTP route, so the browser half can ask
 * where the isolated directory of a session is:
 *
 *   GET /session-isolation/session-directory?sessionId=<id>
 *   -> 200 {"sessionId": "...", "directory": "..."}
 *   -> 404 when the session is unknown, not isolated, or the directory is gone.
 *
 * Only `node:` builtins are imported, so a linked local installation needs no
 * dependencies.
 */
import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

/** Cordis plugin name. */
export const name = 'session-isolation'

/** Required Host services (the optional ones are requested in `apply`). */
export const inject = ['workingDirectory']

/** Default directory name created below (or at) each configured workspace. */
const DEFAULT_BASE_DIR = '_sessions'

/** Read-only HTTP route used by the browser half. */
const SESSION_DIRECTORY_ROUTE = '/session-isolation/session-directory'

/**
 * @typedef {object} SessionIsolationConfig
 * @property {string[]} workspaces Absolute workspace roots whose new sessions are isolated.
 * @property {string} [baseDir] Directory name below each workspace, or an absolute path. Defaults to `_sessions`.
 * @property {boolean} [isolateSubagents] Also isolate subagent sessions. Defaults to `true`.
 */

/**
 * Validate the row config. A bad config throws, so the row fails visibly at
 * activation instead of silently doing nothing.
 * @param {SessionIsolationConfig | undefined} config - the Loader row config.
 * @returns {{ roots: string[], baseDir: string, isolateSubagents: boolean }}
 */
function normalizeConfig(config) {
  const raw = config ?? {}
  const workspaces = raw.workspaces
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    throw new Error('session-isolation: `workspaces` must be a non-empty array of absolute paths')
  }
  const roots = workspaces.map((entry) => {
    if (typeof entry !== 'string' || entry.length === 0 || !isAbsolute(entry)) {
      throw new Error(`session-isolation: workspace entries must be absolute paths, got ${JSON.stringify(entry)}`)
    }
    return resolve(entry)
  })
  const baseDir = raw.baseDir ?? DEFAULT_BASE_DIR
  if (typeof baseDir !== 'string' || baseDir.length === 0) {
    throw new Error('session-isolation: `baseDir` must be a non-empty string')
  }
  const isolateSubagents = raw.isolateSubagents ?? true
  if (typeof isolateSubagents !== 'boolean') {
    throw new Error('session-isolation: `isolateSubagents` must be a boolean')
  }
  return { roots, baseDir, isolateSubagents }
}

/**
 * Compare path identity the way the platform does: case-insensitive on
 * Windows, resolved against the current drive elsewhere.
 * @param {string} path - one side of the comparison.
 * @returns {string}
 */
function pathKey(path) {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * @param {unknown} left - first path-ish value.
 * @param {unknown} right - second path-ish value.
 * @returns {boolean} whether both are the same existing-style path.
 */
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length === 0 || right.length === 0) return false
  return pathKey(left) === pathKey(right)
}

/**
 * Register the session listener and the read-only directory route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {SessionIsolationConfig} config - the Loader row config.
 */
export function apply(ctx, config) {
  const options = normalizeConfig(config)

  ctx.on('agent/created', async ({ agent }) => {
    try {
      await isolate(ctx, options, agent)
    } catch (error) {
      // A throw or rejection here fails and rolls back the whole session
      // creation, so isolation problems only ever warn.
      ctx.logger?.warn?.(`session-isolation: kept the workspace root for this session: ${String(error)}`)
    }
    return undefined
  })

  // The route is a convenience for the browser half: when any of these
  // services is missing (headless composition), isolation still works and the
  // button simply never appears.
  ctx.inject(['webServer', 'connection', 'sessions'], (transport) => {
    transport.effect(
      () => transport.webServer.register({
        kind: 'exact',
        path: SESSION_DIRECTORY_ROUTE,
        handler: (request, response) => serveSessionDirectory(transport, options, request, response),
      }),
      `session-isolation: GET ${SESSION_DIRECTORY_ROUTE}`,
    )
  })
}

/**
 * Switch one Session's working directory to its isolation directory.
 *
 * Isolation applies whenever an agent is entered for a session that is still
 * sitting at the root of a configured workspace: a brand-new session
 * (`startup`), a cleared one (`clear`), and an existing session resumed for the
 * first time after this bundle was installed. Sessions that already have their
 * own working directory — an isolation directory, or a directory the user moved
 * to — are left alone.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ roots: string[], baseDir: string, isolateSubagents: boolean }} options - normalized config.
 * @param {object | undefined} agent - the created agent.
 * @returns {Promise<void>}
 */
async function isolate(ctx, options, agent) {
  const session = agent?.session
  const header = session?.header
  if (session === undefined || header === undefined) return
  if (header.origin === 'subagent' && !options.isolateSubagents) return
  const workspace = options.roots.find((root) => samePath(header.cwd, root))
  if (workspace === undefined) return
  const current = ctx.workingDirectory.get(session)
  // Already isolated, or moved elsewhere by the user or another plugin: keep
  // that choice. A resumed session replays the workspace root until this
  // listener switches it, so an existing session is isolated on first entry.
  if (!samePath(current, workspace)) return
  const directory = isAbsolute(options.baseDir)
    ? join(options.baseDir, String(session.id))
    : join(workspace, options.baseDir, String(session.id))
  await mkdir(directory, { recursive: true })
  if (samePath(directory, current)) return
  await ctx.workingDirectory.set(agent, directory)
}

/**
 * Send a JSON response without any caching.
 * @param {import('node:http').ServerResponse} response - the response to write.
 * @param {number} status - HTTP status code.
 * @param {unknown} payload - JSON-serializable body.
 */
function sendJson(response, status, payload) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(payload))
}

/**
 * Serve `GET /session-isolation/session-directory?sessionId=<id>`.
 *
 * The route only reports directories that this plugin itself created for a
 * session: the session must still belong to a configured workspace and its
 * live working directory must differ from that workspace root.
 *
 * @param {object} transport - the context produced by `ctx.inject`.
 * @param {{ roots: string[], baseDir: string, isolateSubagents: boolean }} options - normalized config.
 * @param {import('node:http').IncomingMessage} request - the HTTP request.
 * @param {import('node:http').ServerResponse} response - the HTTP response.
 * @returns {Promise<void>}
 */
async function serveSessionDirectory(transport, options, request, response) {
  // Same trust fence as the built-in routes: the Host/Origin fence defeats
  // DNS rebinding and browser auth gates the caller.
  const rejection = transport.connection?.requestRejection?.(request)
  if (rejection !== undefined) {
    response.statusCode = rejection
    response.end()
    return
  }
  if (request.method !== 'GET') {
    response.statusCode = 405
    response.setHeader('allow', 'GET')
    response.end()
    return
  }
  let sessionId
  try {
    sessionId = new URL(String(request.url ?? '/'), 'http://localhost').searchParams.get('sessionId')
  } catch {
    sessionId = null
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    sendJson(response, 400, { error: 'missing sessionId query parameter' })
    return
  }
  const session = transport.sessions.get(sessionId)
  if (session === undefined) {
    sendJson(response, 404, { error: 'unknown session' })
    return
  }
  const workspace = session.header?.cwd
  const directory = transport.workingDirectory.get(session)
  if (!options.roots.some((root) => samePath(workspace, root)) || samePath(directory, workspace)) {
    sendJson(response, 404, { error: 'this session is not isolated' })
    return
  }
  try {
    const info = await stat(directory)
    if (!info.isDirectory()) throw new Error('not a directory')
  } catch {
    sendJson(response, 404, { error: 'the session directory does not exist' })
    return
  }
  sendJson(response, 200, { sessionId, directory })
}
