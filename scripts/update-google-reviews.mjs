import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_FILE = join(APP_ROOT, 'public', 'reviews.json')
const MONTH_MS = 28 * 24 * 60 * 60 * 1000

async function isCurrent(file) {
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'))
    return Date.now() - new Date(saved.updatedAt).getTime() < MONTH_MS
  } catch {
    return false
  }
}

export async function updateGoogleReviews({ file = DEFAULT_FILE, force = false } = {}) {
  if (!force && await isCurrent(file)) return { updated: false, reason: 'Die Monatsdatei ist noch aktuell.' }
  const placeId = process.env.GOOGLE_PLACE_ID
  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!placeId || !apiKey) throw new Error('GOOGLE_PLACE_ID oder GOOGLE_MAPS_API_KEY fehlt.')
  const endpoint = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=de`
  const response = await fetch(endpoint, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'rating,userRatingCount,reviews'
    }
  })
  if (!response.ok) {
    const details = await response.json().catch(() => null)
    const googleStatus = details?.error?.status ? ` · ${details.error.status}` : ''
    const reasons = (details?.error?.details || [])
      .map(detail => detail.reason || detail.metadata?.reason)
      .filter(Boolean)
      .join(', ')
    const reasonSuffix = reasons ? ` · ${reasons}` : ''
    throw new Error(`Google Places ${response.status}${googleStatus}${reasonSuffix}: ${details?.error?.message || 'Bewertungen konnten nicht geladen werden.'}`)
  }
  const payload = await response.json()
  const reviews = (payload.reviews || [])
    .filter(review => Number(review.rating) >= 4)
    .filter(review => String(review.text?.text || '').trim())
    .sort((a, b) => new Date(b.publishTime) - new Date(a.publishTime))
    .map(review => ({
      id: review.name || `${review.authorAttribution?.displayName || 'google'}-${review.publishTime}`,
      name: review.authorAttribution?.displayName || 'Google-Nutzer',
      rating: Number(review.rating) || 5,
      text: String(review.text.text).trim(),
      createdAt: review.publishTime,
      updatedAt: review.publishTime
    }))
  const data = {
    updatedAt: new Date().toISOString(),
    source: 'Google Places',
    placeId,
    averageRating: Number(payload.rating || 0),
    totalReviewCount: Number(payload.userRatingCount || 0),
    reviews
  }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  return { updated: true, file, count: reviews.length }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fileArg = process.argv.find(value => value.startsWith('--file='))?.slice(7)
  updateGoogleReviews({ file: fileArg || DEFAULT_FILE, force: process.argv.includes('--force') })
    .then(result => console.log(result.updated ? `${result.count} Rezensionen gespeichert: ${result.file}` : result.reason))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
