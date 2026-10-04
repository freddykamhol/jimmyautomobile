import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const root = process.cwd()
const site = 'https://www.jimmyautomobile.de'
const shareDir = path.join(root, 'public', 'share')
const sourceImage = path.join(root, 'src', 'assets', 'Jimmy.webp')

const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const money = value => new Intl.NumberFormat('de-DE').format(value) + ' €'
const distance = value => new Intl.NumberFormat('de-DE').format(value) + ' km'

const logo = `<g transform="translate(72 62)"><circle cx="34" cy="34" r="31" fill="#f8f6f0" stroke="#a9b5bc" stroke-width="2"/><circle cx="34" cy="34" r="25" fill="#08253d" stroke="#778b98" stroke-width="2"/><text x="34" y="40" fill="#fff" font-family="Georgia,serif" font-weight="700" font-size="19" text-anchor="middle">JA</text><text x="82" y="28" fill="#fff" font-family="Arial,sans-serif" font-weight="700" font-size="21" letter-spacing="5">JIMMY</text><text x="82" y="52" fill="#a9bdca" font-family="Arial,sans-serif" font-size="10" letter-spacing="4">AUTOMOBILE</text></g>`

async function background() {
  return sharp(sourceImage).resize(1200, 630, { fit: 'cover', position: 'centre' }).webp({ quality: 88 }).toBuffer()
}

async function render(name, overlay) {
  const base = await background()
  const svg = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">${overlay}</svg>`
  await sharp(base).composite([{ input: Buffer.from(svg) }]).webp({ quality: 90 }).toFile(path.join(shareDir, name))
}

function page(vehicle) {
  const title = `${vehicle.make} ${vehicle.model} – ${money(vehicle.price)} | Jimmy Automobile`
  const description = `${vehicle.year} · ${distance(vehicle.km)} · ${vehicle.fuel}. Jetzt bei Jimmy Automobile in Boffzen ansehen und Probefahrt anfragen.`
  const url = `${site}/fahrzeuge/${vehicle.id}/`
  const image = `${site}/share/${vehicle.id}.webp`
  const schema = { '@context': 'https://schema.org', '@type': 'Vehicle', name: `${vehicle.make} ${vehicle.model}`, url, image, vehicleModelDate: String(vehicle.year), mileageFromOdometer: { '@type': 'QuantitativeValue', value: vehicle.km, unitCode: 'KMT' }, fuelType: vehicle.fuel, offers: { '@type': 'Offer', price: vehicle.price, priceCurrency: 'EUR', availability: 'https://schema.org/InStock', seller: { '@id': `${site}/#unternehmen` } } }
  return `<!doctype html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><meta name="robots" content="index,follow,max-image-preview:large"><link rel="canonical" href="${url}">
<meta property="og:locale" content="de_DE"><meta property="og:type" content="product"><meta property="og:site_name" content="Jimmy Automobile"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${url}"><meta property="og:image" content="${image}"><meta property="og:image:secure_url" content="${image}"><meta property="og:image:type" content="image/webp"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${esc(vehicle.make + ' ' + vehicle.model + ' bei Jimmy Automobile')}">
<meta property="product:price:amount" content="${vehicle.price}"><meta property="product:price:currency" content="EUR"><meta property="product:availability" content="in stock">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${image}"><meta name="twitter:image:alt" content="${esc(vehicle.make + ' ' + vehicle.model)}"><meta name="theme-color" content="#071c30"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png"><link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180"><link rel="manifest" href="/site.webmanifest"><meta name="application-name" content="Jimmy Automobile"><meta name="apple-mobile-web-app-title" content="Jimmy Auto"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script></head><body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>`
}

// Share-Dateien werden bei jedem Build neu erzeugt, damit keine Bilder
// gelöschter oder ehemaliger Demo-Fahrzeuge veröffentlicht bleiben.
await fs.rm(shareDir, { recursive: true, force: true })
await fs.mkdir(shareDir, { recursive: true })
await render('jimmy-automobile.webp', `<rect width="1200" height="630" fill="url(#fade)"/><defs><linearGradient id="fade"><stop stop-color="#061a2c" stop-opacity=".98"/><stop offset=".62" stop-color="#061a2c" stop-opacity=".72"/><stop offset="1" stop-color="#061a2c" stop-opacity=".2"/></linearGradient></defs>${logo}<text x="72" y="285" fill="#fff" font-family="Arial,sans-serif" font-size="58" font-weight="700">Gute Autos.</text><text x="72" y="352" fill="#c9dce8" font-family="Arial,sans-serif" font-size="58" font-weight="700">Guter Service.</text><text x="75" y="420" fill="#9db2bf" font-family="Arial,sans-serif" font-size="22">Gebrauchtwagen &amp; Werkstatt · Boffzen</text><rect x="72" y="485" width="250" height="52" rx="26" fill="#f3efe6"/><text x="197" y="518" fill="#071c30" font-family="Arial,sans-serif" font-weight="700" font-size="17" text-anchor="middle">JIMMY AUTOMOBILE</text>`)
