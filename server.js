import http from 'node:http'
import { readFile, writeFile, mkdir, stat, unlink } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import nodemailer from 'nodemailer'
import { updateGoogleReviews } from './scripts/update-google-reviews.mjs'

const PORT = Number(process.env.PORT || 3000)
const APP_ROOT = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(APP_ROOT, 'dist'), DATA = process.env.DATA_DIR || join(APP_ROOT, 'data'), DB = join(DATA, 'app.json'), UPLOADS = join(DATA, 'uploads')
const sessions = new Map(), loginAttempts = new Map()
const permissions = ['dashboard', 'vehicles', 'inquiries', 'integrations', 'users']
const json = (res, status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(data)) }
const hashPassword = password => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}` }
const verifyPassword = (password, stored = '') => {
  try {
    const [salt, key] = String(stored).split(':')
    if (!salt || !/^[a-f\d]{128}$/i.test(key || '')) return false
    return timingSafeEqual(Buffer.from(key, 'hex'), scryptSync(password, salt, 64))
  } catch {
    return false
  }
}
const defaults = () => {
  if (String(process.env.ADMIN_PASSWORD || '').length < 10) throw new Error('ADMIN_PASSWORD muss in der Umgebung gesetzt sein und mindestens 10 Zeichen enthalten.')
  return { users: [{ id: 'admin', username: 'admin', name: 'Administrator', role: 'admin', password: hashPassword(process.env.ADMIN_PASSWORD), permissions }], vehicles: [], inquiries: [], settings: { smtp: { host: '', port: 587, secure: false, user: '', password: '', from: 'Jimmy Automobile <info@jimmyautomobile.de>', operator: 'info@jimmyautomobile.de' }, telegram: { botToken: '', chatId: '' } } }
}
async function load() { try { return JSON.parse(await readFile(DB, 'utf8')) } catch { await mkdir(DATA, { recursive: true }); const db = defaults(); await save(db); return db } }
const save = db => writeFile(DB, JSON.stringify(db, null, 2))
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(v => v.trim().split('=').map(decodeURIComponent)))
const auth = async req => { const sid = cookies(req).jimmy_session, session = sid && sessions.get(sid); if (!session || session.expires < Date.now()) { if (sid) sessions.delete(sid); return null } const db = await load(); return db.users.find(u => u.id === session.userId) || null }
const body = async (req, maxBytes = 1e6) => { let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > maxBytes) throw Error('Payload zu groß') } return raw ? JSON.parse(raw) : {} }
const cleanPermissions = value => Array.isArray(value) ? value.filter(x => permissions.includes(x)) : []
const publicUser = u => u && ({ id: u.id, username: u.username, name: u.name, role: u.role, permissions: u.role === 'admin' ? permissions : cleanPermissions(u.permissions) })
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
const transporter = s => nodemailer.createTransport({ host: s.host, port: Number(s.port), secure: Boolean(s.secure), auth: { user: s.user, pass: s.password } })
const storeImage = async (src, vehicleId, index) => {
  const match = String(src || '').match(/^data:image\/(?:webp|png|jpe?g);base64,([a-z\d+/=]+)$/i)
  if (!match) return src
  await mkdir(UPLOADS, { recursive: true }); const name = `${vehicleId}-${index}-${randomBytes(5).toString('hex')}.webp`
  await writeFile(join(UPLOADS, name), Buffer.from(match[1], 'base64')); return `/uploads/${name}`
}
const persistVehicleImages = async vehicle => {
  if (!Array.isArray(vehicle.gallery)) vehicle.gallery = []
  for (let i = 0; i < vehicle.gallery.length; i++) vehicle.gallery[i].src = await storeImage(vehicle.gallery[i].src, vehicle.id, i)
  vehicle.image = vehicle.gallery[0]?.src || await storeImage(vehicle.image, vehicle.id, 0) || ''
  return vehicle
}
const migrateVehicleImages = async db => {
  let changed = false
  for (const vehicle of db.vehicles || []) if (String(vehicle.image || '').startsWith('data:') || vehicle.gallery?.some(item => String(item.src || '').startsWith('data:'))) { await persistVehicleImages(vehicle); changed = true }
  if (changed) await save(db)
}
async function notify(db, q) {
  const subject = `${q.type}: ${q.name}${q.vehicle ? ' – ' + q.vehicle : ''}`
  const text = `Neue Anfrage\n\nName: ${q.name}\nE-Mail: ${q.email || '-'}\nTelefon: ${q.phone || '-'}\nFahrzeug: ${q.vehicle || '-'}\n\n${q.message || ''}`
  const s = db.settings.smtp
  if (s.host && s.user && s.password) { const tx = transporter(s); await tx.sendMail({ from: s.from || s.user, to: s.operator || s.user, replyTo: q.email || undefined, subject, text }); if (q.email) await tx.sendMail({ from: s.from || s.user, to: q.email, subject: 'Ihre Anfrage bei Jimmy Automobile', text: `Guten Tag ${q.name},\n\nvielen Dank für Ihre Anfrage. Wir haben sie erhalten und melden uns schnellstmöglich.\n\nFreundliche Grüße\nJimmy Automobile` }) }
  const t = db.settings.telegram
  if (t.botToken && t.chatId) { const response = await fetch(`https://api.telegram.org/bot${t.botToken}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: t.chatId, text }) }); if (!response.ok) throw Error('Telegram-Benachrichtigung fehlgeschlagen.') }
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, service: 'Jimmy Automobile' })
  if (req.method === 'GET' && url.pathname === '/api/vehicles') { const db = await load(); db.vehicles = Array.isArray(db.vehicles) ? db.vehicles : []; await migrateVehicleImages(db); return json(res, 200, { vehicles: db.vehicles }) }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const key = clientIp(req), attempt = loginAttempts.get(key)
    if (attempt?.blockedUntil > Date.now()) return json(res, 429, { error: 'Zu viele Anmeldeversuche. Bitte in 15 Minuten erneut versuchen.' })
    const b = await body(req), db = await load(), username = String(b.username || '').trim().toLowerCase()
    const u = Array.isArray(db.users) && db.users.find(x => String(x?.username || '').toLowerCase() === username)
    if (!u || !verifyPassword(String(b.password || ''), u.password)) { const count = (attempt?.count || 0) + 1; loginAttempts.set(key, { count, blockedUntil: count >= 5 ? Date.now() + 15 * 60 * 1000 : 0 }); return json(res, 401, { error: 'Benutzername oder Passwort falsch.' }) }
    loginAttempts.delete(key); const sid = randomBytes(32).toString('hex'); sessions.set(sid, { userId: u.id, expires: Date.now() + 12 * 60 * 60 * 1000 })
    return json(res, 200, { user: publicUser(u) }, { 'set-cookie': `jimmy_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.NODE_ENV === 'production' ? '; Secure' : ''}` })
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') { const sid = cookies(req).jimmy_session; if (sid) sessions.delete(sid); return json(res, 200, { ok: true }, { 'set-cookie': 'jimmy_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }) }
  if (req.method === 'GET' && url.pathname === '/api/session') { const u = await auth(req); return u ? json(res, 200, { user: publicUser(u) }) : json(res, 401, { user: null }) }
  if (req.method === 'POST' && url.pathname === '/api/inquiries') {
    const b = await body(req)
    if (b.website) return json(res, 201, { ok: true })
    if (!b.consent || !b.name || (!b.email && !b.phone) || !b.message) return json(res, 400, { error: 'Bitte Name, Nachricht, Datenschutz-Einwilligung und eine Kontaktmöglichkeit angeben.' })
    const db = await load(), now = new Date().toISOString(), q = { id: randomBytes(8).toString('hex'), type: String(b.type || 'Kontaktanfrage').slice(0, 80), vehicle: String(b.vehicle || '').slice(0, 180), name: String(b.name).slice(0, 120), email: String(b.email || '').slice(0, 180), phone: String(b.phone || '').slice(0, 80), message: String(b.message).slice(0, 5000), status: 'Neu', createdAt: now, consentAt: now, messages: [{ id: randomBytes(6).toString('hex'), direction: 'in', text: String(b.message).slice(0, 5000), at: now }] }
    db.inquiries.unshift(q); await save(db); notify(db, q).catch(console.error); return json(res, 201, { ok: true, id: q.id })
  }
  const u = await auth(req)
  if (!u) return json(res, 401, { error: 'Nicht angemeldet.' })
  const can = p => u.role === 'admin' || cleanPermissions(u.permissions).includes(p)
  if (url.pathname === '/api/vehicles' && req.method === 'POST' && can('vehicles')) {
    const b = await body(req, 50e6)
    if (!b.make || !b.model || !Number.isFinite(Number(b.price)) || !Number.isFinite(Number(b.km))) return json(res, 400, { error: 'Marke, Modell, Preis und Kilometerstand sind Pflicht.' })
    const db = await load(), vehicle = { ...b, id: randomBytes(8).toString('hex'), make: String(b.make).slice(0, 80), model: String(b.model).slice(0, 120), price: Number(b.price), km: Number(b.km), createdAt: new Date().toISOString() }
    await persistVehicleImages(vehicle)
    db.vehicles = Array.isArray(db.vehicles) ? db.vehicles : []; db.vehicles.unshift(vehicle); await save(db)
    return json(res, 201, { vehicle })
  }
  const vm = url.pathname.match(/^\/api\/vehicles\/([^/]+)$/)
  if (vm && can('vehicles')) {
    const db = await load(); db.vehicles = Array.isArray(db.vehicles) ? db.vehicles : []; const index = db.vehicles.findIndex(x => x.id === vm[1])
    if (index < 0) return json(res, 404, { error: 'Fahrzeug nicht gefunden.' })
    if (req.method === 'PATCH') {
      const b = await body(req, 50e6)
      if (!b.make || !b.model || !Number.isFinite(Number(b.price)) || !Number.isFinite(Number(b.km))) return json(res, 400, { error: 'Marke, Modell, Preis und Kilometerstand sind Pflicht.' })
      const current = db.vehicles[index]
      const editable = ['make', 'model', 'year', 'registration', 'km', 'price', 'fuel', 'transmission', 'power', 'body', 'condition', 'owners', 'ownersText', 'engine', 'color', 'emission', 'inspection', 'vin', 'sticker', 'consumption', 'availability', 'desc', 'badge', 'equipment', 'gallery', 'image']
      for (const key of editable) if (Object.hasOwn(b, key)) current[key] = b[key]
      current.make = String(current.make).slice(0, 80); current.model = String(current.model).slice(0, 120); current.price = Number(current.price); current.km = Number(current.km); current.updatedAt = new Date().toISOString()
      await persistVehicleImages(current); await save(db)
      return json(res, 200, { vehicle: current })
    }
    if (req.method === 'DELETE') { const [removed] = db.vehicles.splice(index, 1); await save(db); const files = new Set([removed.image, ...(removed.gallery || []).map(item => item.src)].filter(src => String(src).startsWith('/uploads/'))); await Promise.all([...files].map(src => unlink(join(UPLOADS, src.slice('/uploads/'.length))).catch(()=>{}))); return json(res, 200, { ok: true }) }
  }
  if (req.method === 'GET' && url.pathname === '/api/inquiries' && can('inquiries')) { const db = await load(); return json(res, 200, { inquiries: db.inquiries }) }
  const im = url.pathname.match(/^\/api\/inquiries\/([^/]+)(?:\/reply)?$/)
  if (im && can('inquiries')) { const db = await load(), q = db.inquiries.find(x => x.id === im[1]); if (!q) return json(res, 404, { error: 'Anfrage nicht gefunden.' }); if (req.method === 'PATCH') { const b = await body(req); if (['Neu', 'In Bearbeitung', 'Erledigt'].includes(b.status)) q.status = b.status; await save(db); return json(res, 200, { inquiry: q }) } if (req.method === 'POST' && url.pathname.endsWith('/reply')) { const b = await body(req), s = db.settings.smtp; if (!b.text || !q.email) return json(res, 400, { error: 'Antworttext oder Kunden-E-Mail fehlt.' }); if (!s.host || !s.user || !s.password) return json(res, 400, { error: 'SMTP ist noch nicht vollständig konfiguriert.' }); await transporter(s).sendMail({ from: s.from || s.user, to: q.email, replyTo: s.operator || s.user, subject: `Re: ${q.type}${q.vehicle ? ' – ' + q.vehicle : ''}`, text: String(b.text).slice(0, 10000) }); q.messages.push({ id: randomBytes(6).toString('hex'), direction: 'out', text: String(b.text).slice(0, 10000), at: new Date().toISOString(), by: u.name }); q.status = 'In Bearbeitung'; await save(db); return json(res, 200, { inquiry: q }) } }
  if (url.pathname === '/api/users' && can('users')) { const db = await load(); if (req.method === 'GET') return json(res, 200, { users: db.users.map(publicUser) }); if (req.method === 'POST') { const b = await body(req); if (!b.username || String(b.password || '').length < 10) return json(res, 400, { error: 'Benutzername und Passwort mit mindestens 10 Zeichen sind Pflicht.' }); if (db.users.some(x => x.username.toLowerCase() === String(b.username).toLowerCase())) return json(res, 409, { error: 'Benutzername bereits vergeben.' }); db.users.push({ id: randomBytes(8).toString('hex'), username: String(b.username).slice(0, 80), name: String(b.name || b.username).slice(0, 120), role: b.role === 'admin' ? 'admin' : 'staff', password: hashPassword(b.password), permissions: cleanPermissions(b.permissions) }); await save(db); return json(res, 201, { ok: true }) } }
  const um = url.pathname.match(/^\/api\/users\/([^/]+)$/)
  if (um && can('users')) { const db = await load(), target = db.users.find(x => x.id === um[1]); if (!target) return json(res, 404, { error: 'Benutzer nicht gefunden.' }); if (req.method === 'PATCH') { const b = await body(req); if (b.name) target.name = String(b.name).slice(0, 120); if (b.password) { if (String(b.password).length < 10) return json(res, 400, { error: 'Das Passwort muss mindestens 10 Zeichen lang sein.' }); target.password = hashPassword(b.password) } if (target.id !== 'admin') { target.role = b.role === 'admin' ? 'admin' : 'staff'; target.permissions = cleanPermissions(b.permissions) } await save(db); return json(res, 200, { user: publicUser(target) }) } if (req.method === 'DELETE') { if (target.id === 'admin' || target.id === u.id) return json(res, 400, { error: 'Dieser Benutzer kann nicht gelöscht werden.' }); db.users = db.users.filter(x => x.id !== target.id); await save(db); return json(res, 200, { ok: true }) } }
  if (url.pathname === '/api/settings' && can('integrations')) { const db = await load(); if (req.method === 'GET') { const safe = structuredClone(db.settings); if (safe.smtp.password) safe.smtp.password = '********'; if (safe.telegram.botToken) safe.telegram.botToken = '********'; return json(res, 200, { settings: safe }) } if (req.method === 'PUT') { const b = await body(req); if (b.smtp) { if (b.smtp.password === '********') delete b.smtp.password; Object.assign(db.settings.smtp, b.smtp) } if (b.telegram) { if (b.telegram.botToken === '********') delete b.telegram.botToken; Object.assign(db.settings.telegram, b.telegram) } await save(db); return json(res, 200, { ok: true }) } }
  if (req.method === 'POST' && url.pathname === '/api/settings/test' && can('integrations')) { const db = await load(), b = await body(req); if (b.kind === 'smtp') { const s = db.settings.smtp; if (!s.host || !s.user || !s.password) return json(res, 400, { error: 'SMTP ist noch nicht vollständig konfiguriert.' }); await transporter(s).verify(); return json(res, 200, { ok: true, message: 'SMTP-Verbindung erfolgreich.' }) } if (b.kind === 'telegram') { const t = db.settings.telegram; if (!t.botToken || !t.chatId) return json(res, 400, { error: 'Telegram ist noch nicht vollständig konfiguriert.' }); const response = await fetch(`https://api.telegram.org/bot${t.botToken}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: t.chatId, text: 'Jimmy Automobile: Telegram-Schnittstelle erfolgreich verbunden.' }) }); if (!response.ok) return json(res, 400, { error: 'Telegram-Test fehlgeschlagen. Token und Chat-ID prüfen.' }); return json(res, 200, { ok: true, message: 'Telegram-Testnachricht gesendet.' }) } }
  return json(res, 404, { error: 'Nicht gefunden oder keine Berechtigung.' })
}

async function serve(req, res, url) {
  let p = decodeURIComponent(url.pathname), root = ROOT
  if (p.startsWith('/uploads/')) { root = UPLOADS; p = '/' + p.slice('/uploads/'.length) }
  else if (p === '/') p = '/index.html'
  let file = normalize(join(root, p))
  if (!file.startsWith(root)) return json(res, 403, { error: 'Forbidden' })
  try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); await stat(file) }
  catch { if (root === UPLOADS) return json(res, 404, { error: 'Bild nicht gefunden.' }); file = join(ROOT, 'index.html') }
  const extension = extname(file)
  const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.xml': 'application/xml', '.json': 'application/json' }[extension] || 'application/octet-stream'
  const cacheControl = root === UPLOADS ? 'public, max-age=31536000, immutable' : extension === '.html' || p === '/reviews.json' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=31536000, immutable'
  res.writeHead(200, { 'content-type': type, 'cache-control': cacheControl, 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'DENY', 'permissions-policy': 'camera=(), microphone=(), geolocation=()' })
  createReadStream(file).pipe(res)
}
const refreshStaticReviews = () => {
  if (!process.env.GOOGLE_PLACE_ID || !process.env.GOOGLE_MAPS_API_KEY) return
  updateGoogleReviews({ file: join(ROOT, 'reviews.json') }).then(result => {
    if (result.updated) console.log(`${result.count} Google-Rezensionen statisch aktualisiert.`)
  }).catch(error => console.error('Monatliche Rezension-Aktualisierung:', error.message))
}

http.createServer(async (req, res) => { try { const url = new URL(req.url, `http://${req.headers.host}`); if (url.pathname.startsWith('/api/')) await api(req, res, url); else await serve(req, res, url) } catch (e) { const requestId=randomBytes(4).toString('hex');console.error(`[${requestId}]`,e);json(res,500,{error:`Interner Serverfehler (Referenz ${requestId}).`}) } }).listen(PORT, () => { console.log(`Jimmy Automobile läuft auf Port ${PORT} · Daten: ${DB}`); refreshStaticReviews() })
setInterval(refreshStaticReviews, 24 * 60 * 60 * 1000).unref()
