import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

function parserPortOpen(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: 8787 }, () => {
      socket.end()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
  })
}

function localCardBridge(): Plugin {
  let child: ChildProcess | null = null
  return {
    name: 'local-card-bridge',
    async configureServer(server) {
      if (await parserPortOpen()) return
      child = spawn('go', ['run', '.'], {
        cwd: path.join(server.config.root, 'server', 'ddd-http'),
        stdio: 'inherit',
        windowsHide: true,
      })
      server.httpServer?.on('close', () => {
        child?.kill()
        child = null
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), localCardBridge()],
})
