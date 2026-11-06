import { GraphView } from '../components/GraphView'
import type { DriverCardData } from '../types/tacho'

type GraphPageProps = {
  data: DriverCardData | null
  onUploadCard: () => void
  focusedDayUtc?: number | null
}

export function GraphPage({ data, onUploadCard, focusedDayUtc = null }: GraphPageProps) {
  return <GraphView data={data} onUploadCard={onUploadCard} focusedDayUtc={focusedDayUtc} />
}
