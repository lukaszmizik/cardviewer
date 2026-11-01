type ParseCardResult = {
  ok?: boolean
  json?: string
  error?: string
}

type GoRuntime = {
  importObject: WebAssembly.Imports
  run(instance: WebAssembly.Instance): Promise<void>
}

declare global {
  interface Window {
    Go?: new () => GoRuntime
    dddParseCard?: (data: Uint8Array) => ParseCardResult
    dddParserReady?: boolean
  }
}

let loading: Promise<void> | null = null

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (typeof window.dddParseCard === 'function' && window.dddParserReady) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('parser v prohlížeči se nenačetl')
}

async function instantiate(go: GoRuntime): Promise<WebAssembly.Instance> {
  const wasmUrl = '/dddparser.wasm'
  if ('instantiateStreaming' in WebAssembly) {
    try {
      const result = await WebAssembly.instantiateStreaming(fetch(wasmUrl), go.importObject)
      return result.instance
    } catch {
      // některé hostitele neposílají MIME application/wasm
    }
  }
  const response = await fetch(wasmUrl)
  if (!response.ok) {
    throw new Error('soubor parseru dddparser.wasm se nepodařilo stáhnout')
  }
  const bytes = await response.arrayBuffer()
  const result = await WebAssembly.instantiate(bytes, go.importObject)
  return result.instance
}

export function loadDddParser(): Promise<void> {
  if (typeof window.dddParseCard === 'function' && window.dddParserReady) {
    return Promise.resolve()
  }
  if (loading) return loading

  loading = (async () => {
    if (typeof window.Go !== 'function') {
      throw new Error('chybí wasm_exec.js')
    }
    const go = new window.Go()
    const instance = await instantiate(go)
    void go.run(instance)
    await waitUntilReady()
  })().catch((error) => {
    loading = null
    throw error
  })

  return loading
}

export function parseCardInBrowser(bytes: Uint8Array): unknown {
  const parse = window.dddParseCard
  if (typeof parse !== 'function') {
    throw new Error('parser v prohlížeči není připravený')
  }
  const result = parse(bytes)
  if (!result?.ok || !result.json) {
    throw new Error(result?.error || 'Parser dddparser soubor neodkódoval.')
  }
  return JSON.parse(result.json)
}
