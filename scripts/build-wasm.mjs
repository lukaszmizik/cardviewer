import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const force = process.argv.includes('--force') || process.env.FORCE_WASM_BUILD === '1'
const httpDir = path.join(projectRoot, 'server', 'ddd-http')
const publicDir = path.join(projectRoot, 'public')
const wasmOut = path.join(publicDir, 'dddparser.wasm')
const wasmExecOut = path.join(publicDir, 'wasm_exec.js')

if (!force && fs.existsSync(wasmOut) && fs.existsSync(wasmExecOut)) {
  console.log('WASM parser už je v public/, přeskakuji go build')
  process.exit(0)
}

function goEnv(name) {
  const result = spawnSync('go', ['env', name], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    throw new Error(result.stderr || 'go env selhal')
  }
  return result.stdout.trim()
}

const goroot = goEnv('GOROOT')
const wasmExec = [
  path.join(goroot, 'lib', 'wasm', 'wasm_exec.js'),
  path.join(goroot, 'misc', 'wasm', 'wasm_exec.js'),
].find((candidate) => fs.existsSync(candidate))

if (!wasmExec) {
  throw new Error(`wasm_exec.js nebyl nalezen v ${goroot}`)
}

fs.mkdirSync(publicDir, { recursive: true })
fs.copyFileSync(wasmExec, wasmExecOut)

const env = { ...process.env, GOOS: 'js', GOARCH: 'wasm' }
delete env.GOARM
delete env.GOARM64

const build = spawnSync('go', ['build', '-o', wasmOut, './wasm'], {
  cwd: httpDir,
  env,
  stdio: 'inherit',
  windowsHide: true,
})

if (build.status !== 0) {
  process.exit(build.status ?? 1)
}

console.log(`WASM parser: ${path.relative(projectRoot, wasmOut)}`)
console.log(`wasm_exec.js: ${path.relative(projectRoot, wasmExecOut)}`)
