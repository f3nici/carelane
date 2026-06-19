import swaggerJsdoc from 'swagger-jsdoc'
import swaggerUi from 'swagger-ui-express'

const spec = swaggerJsdoc({
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'CareLane API',
      version: '0.1.0',
      description: 'NDIS independent support worker management. Session-authenticated; standard envelope `{ success, data, meta? }` / `{ success:false, error }`. State-changing requests require the `x-csrf-token` header from `/auth/me`.'
    },
    servers: [{ url: '/api/v1' }],
    tags: [
      { name: 'Auth' }, { name: 'Clients' }, { name: 'Agreements' }, { name: 'Shifts' },
      { name: 'Incidents' }, { name: 'Reports' }, { name: 'Billing' }, { name: 'Knowledge' },
      { name: 'Dashboard' }, { name: 'Settings' }
    ]
  },
  apis: ['./server/routes/*.js']
})

/**
 * Mount Swagger UI at /api/docs.
 * @param {import('express').Express} app
 */
export function mountSwagger (app) {
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec))
}
