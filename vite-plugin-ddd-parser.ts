import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

function hostGoEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.GOOS
  delete env.GOARCH
  delete env.GOARM
  delete env.GOARM64
  return env
}

export function dddParserPlugin(): Plugin {
  let child: ChildProcess | undefined

  const stop = () => {
    if (child?.pid == null) return
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } else {
      child.kill()
    }
    child = undefined
  }

  return {
    name: 'ddd-parser-sidecar',
    apply: 'serve',
    configureServer(server) {
      const cwd = path.join(server.config.root, 'server', 'ddd-http')
      const exeName = process.platform === 'win32' ? 'ddd-http.exe' : 'ddd-http'
      const exePath = path.join(cwd, exeName)
      const env = hostGoEnv()

      const start = () => {
        if (!fs.existsSync(exePath)) {
          console.warn('[ddd-parser] Binárka služby chybí, parser nebude dostupný.')
          return
        }
        child = spawn(exePath, [], {
          cwd,
          env,
          stdio: 'inherit',
          windowsHide: true,
        })
        child.on('exit', (code) => {
          if (code && code !== 0) {
            console.warn(`[ddd-parser] Go služba skončila s kódem ${code}`)
          }
        })
      }

      const build = spawn(`go build -o ${exeName} .`, {
        cwd,
        env,
        stdio: 'inherit',
        shell: true,
        windowsHide: true,
      })
      build.on('exit', (code) => {
        if (code !== 0) {
          console.warn('[ddd-parser] go build selhal. Spusťte npm run parser v novém terminálu bez GOOS=js.')
          return
        }
        start()
      })

      server.httpServer?.once('close', stop)
      process.once('exit', stop)
    },
  }
}
