import { defineConfig } from 'vite'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
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

    for (const route of routes) {
      const target = join('dist', route, 'index.html')
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync('dist/index.html', target)
    }

    // Static hosts can use the SPA shell for routes created after deployment.
    copyFileSync('dist/index.html', 'dist/404.html')
  },
})

export default defineConfig({
  plugins: [staticHtmlRoutes()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
})
