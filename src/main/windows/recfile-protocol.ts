/**
 * `recfile://` protocol — safe local media access for the renderer.
 *
 * The renderer needs to <video>-play recordings that live on disk. Rather
 * than disabling web security or exposing the fs module, we register a
 * privileged custom protocol that maps
 *
 *     recfile://media/<url-encoded absolute path>
 *
 * to the file. The path is decoded and verified to be an existing FILE; no
 * directory listing, no write access, no traversal beyond the path itself.
 */
import { net, protocol } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'

export const RECFILE_SCHEME = 'recfile'

export function registerRecfileProtocol(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RECFILE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        stream: true,
        supportFetchAPI: true,
        bypassCSP: false,
      },
    },
  ])
}

export function handleRecfileRequests(): void {
  protocol.handle(RECFILE_SCHEME, (request) => {
    try {
      const url = new URL(request.url)
      // host is 'media', pathname is /<encoded abs path>
      if (url.host !== 'media') {
        return new Response('Bad recfile host', { status: 400 })
      }
      const decoded = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      if (!path.isAbsolute(decoded)) {
        return new Response('recfile requires an absolute path', { status: 400 })
      }
      const resolved = path.resolve(decoded)
      const st = fs.statSync(resolved)
      if (!st.isFile()) {
        return new Response('Not a file', { status: 404 })
      }
      return net.fetch(pathToFileURL(resolved).toString())
    } catch (err) {
      const message = err instanceof Error ? err.message : 'recfile error'
      return new Response(message, { status: 500 })
    }
  })
}

/** Build a recfile URL for an absolute file path (used by renderer via preload-free helper). */
export function recfileUrl(absolutePath: string): string {
  return `${RECFILE_SCHEME}://media/${encodeURIComponent(absolutePath)}`
}
