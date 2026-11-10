/**
 * Lokální diagnostika WorkPeriod z DDD nebo JSON výstupu dddparser.
 *
 * Binární karta: go run server/ddd-http/cmd/cardjson (stejný parse.Card jako HTTP parser).
 * Alternativa: JSON soubor, nebo POST na běžící `npm run parser`.
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { diagnoseWorkPeriodsFromCard, formatWorkPeriodDiagnosticsReport } from '../src/analysis/workPeriodDiagnostics.ts'
import { mapDddParserJson } from '../src/utils/dddMapper.ts'
import { looksLikeJson } from '../src/utils/dddParser.ts'

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const parserUrl = process.env.DDD_PARSER_URL ?? 'http://127.0.0.1:8787/parse-card'

function usage(): never {
  console.error('Použití: node --experimental-strip-types scripts/diagnose-work-periods.ts <soubor.ddd|json>')
  console.error('  Binární DDD: vyžaduje Go (go run server/ddd-http/cmd/cardjson) nebo běžící npm run parser.')
  process.exit(2)
}

async function loadParserJson(filePath: string): Promise<unknown> {
  const bytes = readFileSync(filePath)
  if (looksLikeJson(bytes)) {
    return JSON.parse(bytes.toString('utf-8'))
  }

  const cardjsonDir = path.join(projectRoot, 'server', 'ddd-http', 'cmd', 'cardjson')
  const go = spawnSync('go', ['run', '.', filePath], {
    cwd: cardjsonDir,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (go.status === 0 && go.stdout.trim()) {
    return JSON.parse(go.stdout)
  }

  try {
    const response = await fetch(parserUrl, {
      method: 'POST',
      body: bytes,
      headers: { 'Content-Type': 'application/octet-stream' },
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    return await response.json()
  } catch {
    const hint = [
      'Soubor se nepodařilo dekódovat.',
      go.stderr?.trim() || go.stdout?.trim() || '',
      `Spusťte: go run -C server/ddd-http/cmd/cardjson <soubor>, nebo npm run parser a nastavte DDD_PARSER_URL.`,
    ]
      .filter(Boolean)
      .join('\n')
    console.error(hint)
    process.exit(1)
  }
}

const fileArg = process.argv[2]
if (!fileArg) usage()

const parserJson = await loadParserJson(path.resolve(fileArg))
const card = mapDddParserJson(parserJson)
const report = diagnoseWorkPeriodsFromCard(card)
console.log(formatWorkPeriodDiagnosticsReport(report))
