import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // Fixed secrets so encryption is deterministic across the test run; each
    // test file uses its own throwaway DB path (see test/helpers/db.js).
    env: {
      NODE_ENV: 'test',
      ENCRYPTION_SECRET: 'carelane-test-encryption-secret',
      SESSION_SECRET: 'carelane-test-session-secret'
    },
    // better-sqlite3 is native; keep files sequential for deterministic DBs.
    fileParallelism: false
  }
})
