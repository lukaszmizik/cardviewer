import { DiagnosticReview } from '../components/DiagnosticReview'
import type { DriverCardData } from '../types/tacho'

type CompliancePageProps = {
  card: DriverCardData | null
  onOpenDay?: (atUtc: number) => void
}

export function CompliancePage({ card, onOpenDay }: CompliancePageProps) {
  return (
    <section className="app-content-card page-placeholder">
      <h1>Analýza aktivit</h1>
      <p>Přehled toho, co jádro z karty doložilo, kde zůstává více výkladů a co ještě neumí.</p>
      <h2>Případy k prověření</h2>
      <DiagnosticReview key={card?.cardNumber ?? 'none'} card={card} onOpenDay={onOpenDay} />
    </section>
  )
}
