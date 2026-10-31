import { GraphView } from '../components/GraphView'
import type { DriverCardData } from '../types/tacho'

type GraphPageProps = {
  data: DriverCardData | null
  onUploadCard: () => void
}

export function GraphPage({ data, onUploadCard }: GraphPageProps) {
  return <GraphView data={data} onUploadCard={onUploadCard} />
}
