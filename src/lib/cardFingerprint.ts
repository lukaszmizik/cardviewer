/** Rychlý otisk binárního souboru — pro rozpoznání stejné karty bez plného hash. */
export function fingerprintBytes(bytes: Uint8Array): string {
  let hash = 2_166_136_261
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index]!
    hash = Math.imul(hash, 16_777_619)
  }
  return `b${bytes.length}:${hash >>> 0}`
}
