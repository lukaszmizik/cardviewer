import { useState } from 'react'
import { ComplianceReviewView } from '../components/ComplianceReviewView'
import { DiagnosticReview } from '../components/DiagnosticReview'
import type { DriverCardData } from '../types/tacho'

type CompliancePageProps = {
  card: DriverCardData | null
  onOpenDay?: (atUtc: number) => void
}

export function CompliancePage({ card, onOpenDay }: CompliancePageProps) {
  const [nowUtc] = useState(() => Date.now())
  return (
    <section className="app-content-card page-placeholder">
      <h1>Kontrola přestupků</h1>
      <p>Posledních 56 dnů a dnešek. Starší jízdy se do součtů počítají, v mapě jsou jen zjištění z tohoto období.</p>
      {card == null ? (
        <p>Nejdřív nahrajte kartu řidiče.</p>
      ) : (
        <ComplianceReviewView activities={card.activities} nowUtc={nowUtc} onOpenDay={onOpenDay} />
      )}
      <details className="compliance-technical">
        <summary>Technické podklady</summary>
        <DiagnosticReview key={card?.cardNumber ?? 'none'} card={card} onOpenDay={onOpenDay} />
      </details>
    </section>
  )
}
