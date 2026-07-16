import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { execSync } from 'child_process'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '')
  const serverPort = env.PORT ?? process.env.PORT ?? 3001

  // Inject the latest git tag (e.g. v7) as the build version. Falls back to
  // 'dev' when git is unavailable or no tag exists. Used by the navbar Brand.
  let appVersion = 'dev'
  try {
    appVersion = execSync('git describe --tags --abbrev=0', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'dev'
  } catch { /* no tags / not a git repo -> dev */ }

  return {
    plugins: [react(), tailwindcss()],
    base: process.env.VITE_BASE ?? '/',
    envDir: path.resolve(__dirname, '..'),
    define: {
      __SERVER_PORT__: JSON.stringify(String(serverPort)),
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      proxy: {
        // Force IPv4 - on Windows + Node 17+, `localhost` resolves to ::1 first,
        // which can collide with wslrelay / Docker Desktop listeners on the same port.
        '/api': `http://127.0.0.1:${serverPort}`,
        '/v1': `http://127.0.0.1:${serverPort}`,
      },
    },
  }
})
