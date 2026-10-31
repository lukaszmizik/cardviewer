import type { ClockMode } from '../lib/clock'

type TimeScaleSelectProps = {
  value: ClockMode
  onChange: (mode: ClockMode) => void
}

export function TimeScaleSelect({ value, onChange }: TimeScaleSelectProps) {
  return (
    <label className="time-scale-select">
      <span className="time-scale-select-label">Časová osa</span>
      <select
        className="time-scale-select-field"
        value={value}
        onChange={(event) => onChange(event.target.value as ClockMode)}
        aria-label="Zobrazení času v grafu"
      >
        <option value="local">Místní čas</option>
        <option value="utc">UTC</option>
      </select>
    </label>
  )
}
