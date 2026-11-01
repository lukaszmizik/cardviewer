type MapsTarget = {
  latitude?: number
  longitude?: number
  countryCode?: string
  label?: string
}

function hasCoords(lat?: number, lng?: number): lat is number {
  return lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)
}

function parseCoordsFromLabel(label?: string): { latitude: number; longitude: number } | null {
  if (!label) return null
  const match = label.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/)
  if (!match) return null
  const latitude = Number(match[1])
  const longitude = Number(match[2])
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return { latitude, longitude }
}

/** Odkaz na Google Maps: GPS souřadnice mají přednost před kódem země / popiskem. */
export function googleMapsUrl(target: MapsTarget): string | null {
  if (hasCoords(target.latitude, target.longitude)) {
    return `https://www.google.com/maps?q=${target.latitude},${target.longitude}`
  }
  const parsed = parseCoordsFromLabel(target.label)
  if (parsed) {
    return `https://www.google.com/maps?q=${parsed.latitude},${parsed.longitude}`
  }
  const country = target.countryCode?.trim()
  if (country && /^[A-Z]{2}$/i.test(country)) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(country.toUpperCase())}`
  }
  const label = target.label?.trim()
  if (label && label !== '—') {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(label)}`
  }
  return null
}
