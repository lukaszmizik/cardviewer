import { Fragment, useState } from 'react'
import type { ActivityAnalysis } from '../analysis/analyzeDriverActivities.ts'
import { buildDailyRestOverview, restOverviewColor } from './dailyRestOverview.ts'

type DailyRestOverviewProps = {
  analysis: ActivityAnalysis
  onOpenDay?: (atUtc: number) => void
}

export function DailyRestOverview({ analysis, onOpenDay }: DailyRestOverviewProps) {
  const overview = buildDailyRestOverview(analysis)
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (id: string) => {
    setOpenIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  return (
    <section className="diagnostic-review" aria-label="Denní odpočinky">
      <h3>Denní odpočinky</h3>
      {overview.status === 'needs_anchor' ? (
        <p className="diagnostic-hint">{overview.message}</p>
      ) : (
        <div className="diagnostic-table-wrap">
          <table className="diagnostic-table">
            <caption className="diagnostic-hint">Datum a čas jsou v UTC. Barva označuje druh odpočinku, ne dodržení předpisu.</caption>
            <thead>
              <tr>
                <th scope="col">Datum</th>
                <th scope="col">Odpočinek</th>
                <th scope="col">Typ / výsledek</th>
                <th scope="col">Podrobnosti</th>
              </tr>
            </thead>
            <tbody>
              {overview.rows.map((row) => {
                const open = openIds.has(row.id)
                const color = restOverviewColor(row.tone)
                return (
                  <Fragment key={row.id}>
                    <tr>
                      <td>
                        {onOpenDay != null ? (
                          <button
                            type="button"
                            className="diagnostic-day-link"
                            onClick={() => onOpenDay(row.atUtc)}
                          >
                            {row.dateUtc}
                          </button>
                        ) : row.dateUtc}
                      </td>
                      <td>
                        {color != null ? <span className="diagnostic-rest-mark" style={{ background: color }} aria-hidden="true" /> : null}
                        {row.restSummary}
                      </td>
                      <td>
                        {row.attention ? <span className="diagnostic-attention">⚠ </span> : null}
                        {row.result}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="diagnostic-detail-toggle"
                          aria-expanded={open}
                          onClick={() => toggle(row.id)}
                        >
                          {open ? 'Skrýt' : 'Podrobnosti'}
                        </button>
                      </td>
                    </tr>
                    {open ? (
                      <tr className="diagnostic-table-detail">
                        <td colSpan={4}>
                          <dl className="diagnostic-detail-list">
                            {row.details.map((detail, index) => (
                              <div key={`${detail.label}:${index}`}>
                                <dt>{detail.label}</dt>
                                <dd>{detail.value}</dd>
                              </div>
                            ))}
                          </dl>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
