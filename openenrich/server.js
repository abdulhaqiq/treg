#!/usr/bin/env node
// `npm start`: serves the built app from dist/ and the API on one port.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleApi } from './api.js'

const DIST = join(fileURLToPath(new URL('.', import.meta.url)), 'dist')
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
const PORT = Number(process.env.PORT || 5180)

createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) return handleApi(req, res)
  const path = normalize(new URL(req.url, 'http://x').pathname).replace(/^(\.\.[/\\])+/, '')
  for (const file of [join(DIST, path), join(DIST, 'index.html')]) {
    try {
      const body = await readFile(file)
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' })
      return res.end(body)
    } catch {}
  }
  res.writeHead(404).end()
}).listen(PORT, '127.0.0.1', () => console.log(`openenrich on http://localhost:${PORT}`))
