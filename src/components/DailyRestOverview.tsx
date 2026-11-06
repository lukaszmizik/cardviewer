import type { ActivityAnalysis } from '../analysis/analyzeDriverActivities.ts'
import { buildDailyRestOverview } from './dailyRestOverview.ts'

type DailyRestOverviewProps = {
  analysis: ActivityAnalysis
}

export function DailyRestOverview({ analysis }: DailyRestOverviewProps) {
  const overview = buildDailyRestOverview(analysis)
  return (
    <section className="diagnostic-review" aria-label="Denní odpočinky">
      <h3>Denní odpočinky</h3>
      {overview.status === 'needs_anchor' ? (
        <p className="diagnostic-hint">{overview.message}</p>
      ) : (
        <div className="diagnostic-table-wrap">
          <table className="diagnostic-table">
            <caption className="diagnostic-hint">Datum a čas jsou v UTC.</caption>
            <thead>
              <tr>
                <th scope="col">Datum</th>
                <th scope="col">Interval</th>
                <th scope="col">Délka</th>
                <th scope="col">Rozpoznání</th>
                <th scope="col">Poznámka</th>
              </tr>
            </thead>
            <tbody>
              {overview.rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.dateUtc}</td>
                  <td>{row.intervalUtc}</td>
                  <td>{row.duration}</td>
                  <td>{row.recognition}</td>
                  <td>{row.note === '' ? '—' : row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
