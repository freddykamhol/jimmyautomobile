import { defineConfig } from 'vite'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const staticHtmlRoutes = () => ({
  name: 'static-html-routes',
  closeBundle() {
    const routes = [
      'fahrzeuge',
      'admin',
      'admin/fahrzeuge',
      'admin/fahrzeuge/neu',
      'admin/anfragen',
      'admin/schnittstellen',
      'admin/benutzer',
    ]

    try {
      const data = JSON.parse(readFileSync('data/app.json', 'utf8'))
      for (const vehicle of data.vehicles || []) {
        if (vehicle?.id) routes.push(`fahrzeuge/${encodeURIComponent(vehicle.id)}`)
      }
    } catch {
      // A fresh installation may not have a vehicle database yet.
    }

    const shell = readFileSync('dist/index.html', 'utf8')
    for (const route of routes) {
      const target = join('dist', route, 'index.html')
      const depth = route.split('/').length
      const prefix = '../'.repeat(depth)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, shell.replaceAll('./assets/', `${prefix}assets/`), 'utf8')
    }

    // Static hosts can use the SPA shell for routes created after deployment.
    writeFileSync('dist/404.html', shell, 'utf8')
  },
})

export default defineConfig({
  // The site also runs below a repository path (for example GitHub Pages).
  base: './',
  plugins: [staticHtmlRoutes()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
})
