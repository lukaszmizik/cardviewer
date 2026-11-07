import { useState } from 'react'
import { ComplianceReviewView } from '../components/ComplianceReviewView'
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
      <p>Výchozí je posledních 56 dnů a dnešek. Lze zvolit celou historii nebo vlastní období. Do součtů vstupuje celá karta, v mapě jsou jen zjištění z vybraného období.</p>
      {card == null ? (
        <p>Nejdřív nahrajte kartu řidiče.</p>
      ) : (
        <ComplianceReviewView activities={card.activities} nowUtc={nowUtc} onOpenDay={onOpenDay} />
      )}
    </section>
  )
}
