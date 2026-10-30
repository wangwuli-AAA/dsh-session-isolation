/**
 * Session isolation — browser half.
 *
 * Adds one button to the conversation header that opens the isolated working
 * directory of the current session (`<workspace>/<baseDir>/<session-id>`) in
 * the system file manager. It reuses the paths app catalog and open route that
 * ship with the desktop profile:
 *
 *   GET  /session-isolation/session-directory?sessionId=<id>  (this bundle)
 *   GET  /open-in-app/apps                                   (built-in)
 *   POST /open-in-app/open                                   (built-in)
 *
 * The button only renders for sessions the Host reports as isolated, so
 * sessions from unconfigured workspaces keep a clean header. The header can
 * mount before the Host finishes isolating a resumed session, so a negative
 * lookup is not cached and the button asks again for a few seconds.
 *
 * It also repairs file addresses before they reach the sidebar-right service.
 * The rest of the desktop client assumes the Session working directory is the
 * Workspace root; an isolated session breaks that assumption, and a few code
 * paths end up asking the Host for a path joined without its separator (for
 * example `<root>_sessions/<id>/file.md`) or for a path that is relative to the
 * working directory instead of the workspace root. Both shapes are corrected
 * here, for file addresses only: the repair runs inside `openResource`, so the
 * file panel, chat file cards, markdown links and document preview all keep
 * working inside isolated sessions.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-isolation',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')

    const SLOT_NAME = 'conversation.session.header.utilities'
    const NS = 'session-isolation'
    const DIRECTORY_ROUTE = '/session-isolation/session-directory'
    const APPS_ROUTE = '/open-in-app/apps'
    const OPEN_ROUTE = '/open-in-app/open'
    const FALLBACK_APP = 'explorer'

    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'
    const SESSION_SCOPE = 'session'
    const DEFAULT_BASE_DIR = '_sessions'

    /** How long the header keeps asking for the directory after a miss. */
    const ISOLATION_LOOKUP_RETRY_MS = 500
    /** 12 × 500 ms: covers the Host isolating resumed sessions while the window boots. */
    const ISOLATION_LOOKUP_RETRIES = 12

    const DICTS = {
      zh: {
        open: '打开会话文件夹',
        opening: '正在打开…',
        failed: '打开失败，点击重试',
      },
      en: {
        open: 'Open session folder',
        opening: 'Opening…',
        failed: 'Could not open, click to retry',
      },
    }

    const CSS = [
      '.ssi-folder{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsh-text-secondary,var(--dsh-muted-foreground,#6b7280));cursor:pointer}',
      '.ssi-folder:hover{background:var(--dsh-bg-hover,rgba(127,127,127,.12));color:var(--dsh-text-primary,var(--dsh-foreground,#111827))}',
      '.ssi-folder--busy{opacity:.55;cursor:progress}',
    ].join('\n')

    /** Plugin context captured in `apply`, used by the button for late wiring. */
    let activeCtx

    /** sessionId -> { settled, value, promise }; `value` is a Host absolute directory or null. */
    const isolationCache = new Map()

    /** Folder glyph, drawn with `currentColor` so it follows the button theme. */
    function folderIcon() {
      return React.createElement('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'currentColor',
        'aria-hidden': true,
      }, React.createElement('path', {
        d: 'M2 3.5A1.5 1.5 0 0 1 3.5 2h2.9c.4 0 .78.16 1.06.44l1.07 1.07c.14.14.33.22.53.22H12.5A1.5 1.5 0 0 1 14 5.23V12a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12z',
      }))
    }

    /** `t` comes from the slot's bound locale; keep a fallback for safety. */
    function translate(props) {
      if (typeof props.t === 'function') return props.t
      return (key) => (DICTS.zh[key] ?? key)
    }

    //#region file address helpers

    function encodeSegment(segment) {
      return encodeURIComponent(segment).replace(/%3A/gi, ':')
    }

    function decodeSegment(segment) {
      try {
        return decodeURIComponent(segment)
      } catch {
        return undefined
      }
    }

    /**
     * Parse `dsh-resource://file/session/<id>/<path...>` into decoded segments.
     * Addresses with another protocol or scope, or malformed ones, return
     * `undefined` and are never rewritten.
     */
    function parseFileAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined
      const tail = address.slice(FILE_ADDRESS_PREFIX.length)
      let stop = tail.length
      for (const marker of ['?', '#']) {
        const index = tail.indexOf(marker)
        if (index >= 0 && index < stop) stop = index
      }
      const segments = tail.slice(0, stop).split('/').map(decodeSegment)
      if (segments.some((segment) => segment === undefined || segment === '')) return undefined
      if (segments[0] !== SESSION_SCOPE || segments.length < 3) return undefined
      return { sessionId: segments[1], segments: segments.slice(2) }
    }

    function toFileAddress(sessionId, segments) {
      return FILE_ADDRESS_PREFIX + SESSION_SCOPE + '/' + encodeSegment(sessionId) + '/' + segments.map(encodeSegment).join('/')
    }

    function isAbsoluteSegments(segments) {
      if (segments.length === 0) return false
      const first = segments[0]
      if (/^[A-Za-z]:$/.test(first)) return true
      if (first === '' && segments.length > 1) return true
      return first.startsWith('/')
    }

    function toPosix(path) {
      return path.replace(/\\/g, '/').replace(/\/+$/, '')
    }

    function sessionsService(ctx) {
      if (ctx === undefined) return undefined
      try {
        const injected = ctx.sessions
        if (injected !== undefined) return injected
      } catch {
        // fall through to `ctx.get`
      }
      try {
        return ctx.get?.('sessions')
      } catch {
        return undefined
      }
    }

    function sessionSnapshot(ctx) {
      try {
        return sessionsService(ctx)?.list?.getSnapshot?.()
      } catch {
        return undefined
      }
    }

    function cwdOf(ctx, sessionId) {
      const cwd = sessionSnapshot(ctx)?.byId?.[sessionId]?.cwd
      return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
    }

    function workspaceRoots(ctx) {
      const roots = new Set()
      const snapshot = sessionSnapshot(ctx)
      if (snapshot?.byId !== undefined) {
        for (const entry of Object.values(snapshot.byId)) {
          if (typeof entry?.cwd === 'string' && entry.cwd.length > 0) roots.add(entry.cwd)
        }
      }
      return roots
    }

    //#endregion
    //#region isolation lookup

    function isolationState(sessionId) {
      const cached = isolationCache.get(sessionId)
      if (cached !== undefined) return cached
      const entry = { settled: false, value: null, promise: undefined }
      entry.promise = (async () => {
        try {
          const response = await fetch(`${DIRECTORY_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, {
            headers: { accept: 'application/json' },
          })
          if (!response.ok) return null
          const payload = await response.json()
          return typeof payload?.directory === 'string' && payload.directory.length > 0 ? payload.directory : null
        } catch {
          return null
        }
      })().then((value) => {
        entry.settled = true
        entry.value = value
        // A resumed session can still be waiting for its isolated directory.
        // Never cache a miss: the next lookup must be able to succeed.
        if (value === null) isolationCache.delete(sessionId)
        return value
      })
      isolationCache.set(sessionId, entry)
      return entry
    }

    function settledIsolation(sessionId) {
      const entry = isolationCache.get(sessionId)
      return entry?.settled === true ? entry.value : undefined
    }

    //#endregion
    //#region address repair

    /**
     * Repair the missing-separator shape: the Host absolute path glued
     * `<workspace root><baseDir>/...` (for example
     * `D:/.../default-workspace_sessions/session-x/a.md`). Restricting the
     * match to a known workspace root followed by the default base directory
     * keeps every other path untouched.
     */
    function repairGluedPath(ctx, sessionId, segments) {
      const path = segments.join('/')
      const roots = workspaceRoots(ctx)
      const cwd = cwdOf(ctx, sessionId)
      if (cwd !== undefined) roots.add(cwd)
      for (const root of roots) {
        const normalizedRoot = toPosix(root)
        if (normalizedRoot.length === 0) continue
        if (!path.startsWith(normalizedRoot)) continue
        const remainder = path.slice(normalizedRoot.length)
        if (remainder.length === 0 || remainder.startsWith('/')) continue
        if (!remainder.startsWith(DEFAULT_BASE_DIR)) continue
        return toFileAddress(sessionId, (normalizedRoot + '/' + remainder).split('/'))
      }
      return undefined
    }

    /**
     * Repair the working-directory-relative shape: a relative path that the
     * client resolves against the workspace root while the Host resolved it
     * against the Session working directory (the isolated directory). Runs
     * only after the Host confirmed the session is isolated.
     */
    function repairWorkingDirectoryRelative(ctx, sessionId, segments) {
      const isolation = settledIsolation(sessionId)
      if (isolation === undefined || isolation === null) return undefined
      const cwd = cwdOf(ctx, sessionId)
      if (cwd === undefined) return undefined
      const normalizedRoot = toPosix(cwd)
      const normalizedDirectory = toPosix(isolation)
      if (!normalizedDirectory.startsWith(normalizedRoot + '/')) return undefined
      const workingRelative = normalizedDirectory.slice(normalizedRoot.length + 1)
      if (workingRelative.length === 0) return undefined
      const path = segments.join('/')
      if (path === workingRelative || path.startsWith(workingRelative + '/')) return undefined
      return toFileAddress(sessionId, (workingRelative + '/' + path).split('/'))
    }

    /** Synchronous repair; `undefined` means "nothing to change" or "wait for the isolation lookup". */
    function repairAddress(ctx, address) {
      const parsed = parseFileAddress(address)
      if (parsed === undefined) return undefined
      const repaired = isAbsoluteSegments(parsed.segments)
        ? repairGluedPath(ctx, parsed.sessionId, parsed.segments)
        : repairWorkingDirectoryRelative(ctx, parsed.sessionId, parsed.segments)
      return repaired
    }

    /** Async repair, used only for relative addresses whose isolation is still unknown. */
    function repairAddressAsync(ctx, address) {
      const parsed = parseFileAddress(address)
      if (parsed === undefined || isAbsoluteSegments(parsed.segments)) return undefined
      const cached = isolationCache.get(parsed.sessionId)
      if (cached?.settled === true) return undefined
      return isolationState(parsed.sessionId).promise
        .then(() => repairAddress(ctx, address))
        .catch(() => undefined)
    }

    //#endregion
    //#region sidebar-right address repair wiring

    function sidebarRightService(ctx) {
      if (ctx === undefined) return undefined
      try {
        const injected = ctx.sidebarRight
        if (injected !== undefined) return injected
      } catch {
        // fall through to `ctx.get`
      }
      try {
        return ctx.get?.('sidebarRight')
      } catch {
        return undefined
      }
    }

    /**
     * Wrap `sidebarRight.openResource` so file addresses are repaired before
     * the tab is created. Idempotent: the second call finds the wrapper already
     * installed and returns `undefined`.
     */
    function installAddressRepair(ctx) {
      const service = sidebarRightService(ctx)
      if (service === undefined || typeof service.openResource !== 'function') return undefined
      if (service.__sessionIsolationRepair === true) return undefined
      const original = service.openResource
      function openResource(address, options) {
        let repaired
        try {
          repaired = repairAddress(ctx, address)
        } catch {
          repaired = undefined
        }
        if (typeof repaired === 'string' && repaired !== address) {
          return original.call(service, repaired, options)
        }
        let pending
        try {
          pending = repairAddressAsync(ctx, address)
        } catch {
          pending = undefined
        }
        if (pending !== undefined) {
          return pending.then((value) => original.call(service, typeof value === 'string' ? value : address, options))
        }
        return original.call(service, address, options)
      }
      try {
        service.openResource = openResource
        service.__sessionIsolationRepair = true
      } catch (error) {
        ctx?.logger?.warn?.('session-isolation: cannot install the address repair: ' + String(error))
        return undefined
      }
      return () => {
        try {
          if (service.openResource === openResource) service.openResource = original
          delete service.__sessionIsolationRepair
        } catch {
          // the service is going away; nothing to restore
        }
      }
    }

    //#endregion

    function SessionFolderAction(props) {
      const sessionId = props.sessionId
      const useSessions = props.useSessions
      const t = translate(props)
      // Subscribing through `useSessions` keeps the action in sync with the
      // session list without talking to the Host on every render.
      const cwd = typeof useSessions === 'function' ? useSessions((state) => state?.byId?.[sessionId]?.cwd) : undefined
      const [directory, setDirectory] = React.useState(null)
      const [phase, setPhase] = React.useState('loading')
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        let timer
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          setPhase('absent')
          return undefined
        }
        // The header mounts after the client services settle, so this is the
        // reliable place to (re)install the address repair.
        installAddressRepair(activeCtx)
        setPhase('loading')
        setDirectory(null)
        // A resumed session is isolated while the window boots. The header can
        // render before that finishes, so a miss is retried instead of hiding
        // the button forever.
        const probe = (attempt) => {
          isolationState(sessionId).promise
            .then((value) => {
              if (!alive) return
              if (typeof value === 'string') {
                setDirectory(value)
                setPhase('ready')
                return
              }
              if (attempt >= ISOLATION_LOOKUP_RETRIES) {
                setPhase('absent')
                return
              }
              timer = setTimeout(() => probe(attempt + 1), ISOLATION_LOOKUP_RETRY_MS)
            })
            .catch(() => {
              if (alive) setPhase('absent')
            })
        }
        probe(0)
        return () => {
          alive = false
          if (timer !== undefined) clearTimeout(timer)
        }
        // `cwd` is listed so a working-directory change re-asks the Host.
      }, [sessionId, cwd])

      if (phase !== 'ready') return null

      const open = () => {
        if (busy) return
        setBusy(true)
        setNotice(null)
        fetch(APPS_ROUTE, { headers: { accept: 'application/json' } })
          .then(async (response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            const payload = await response.json()
            return Array.isArray(payload?.apps) && payload.apps.length > 0 ? payload.apps[0] : FALLBACK_APP
          })
          .catch(() => FALLBACK_APP)
          .then((app) => fetch(OPEN_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ app, path: directory }),
          }))
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status)
          })
          .catch(() => {
            setNotice(t('failed'))
          })
          .finally(() => {
            setBusy(false)
          })
      }

      return React.createElement('button', {
        type: 'button',
        className: busy ? 'ssi-folder ssi-folder--busy' : 'ssi-folder',
        title: notice ?? t('open'),
        'aria-label': t('open'),
        onClick: open,
      }, folderIcon())
    }

    /** Styles are owned by this plugin and removed with it. */
    function injectStyles() {
      const style = document.createElement('style')
      style.dataset.plugin = NS
      style.dataset.pluginCss = 'session-isolation'
      style.textContent = CSS
      document.head.append(style)
      return () => {
        style.remove()
      }
    }

    function apply(ctx) {
      activeCtx = ctx
      ctx.effect(() => ctx.locale.register(NS, DICTS), 'session-isolation: client locale dictionary')
      ctx.effect(() => injectStyles(), 'session-isolation: client styles')
      ctx.effect(() => installAddressRepair(ctx), 'session-isolation: file address repair')
      ctx.slots.inject(SLOT_NAME, () => ctx.slots.register({
        name: SLOT_NAME,
        id: 'session-isolation-folder',
        order: -9,
        locale: NS,
      }, SessionFolderAction))
    }

    module.exports = {
      apply,
      inject: ['slots', 'locale', 'sessions'],
      name: 'session-isolation',
      // Exposed for offline checks; not part of the client plugin contract.
      __internals: { parseFileAddress, repairAddress, installAddressRepair, isolationState },
    }
    return module.exports
  },
})
