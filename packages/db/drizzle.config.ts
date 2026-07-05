import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // Intentional single tooling-time exception to the central-reader rule
    // (packages/runtime/src/config.ts): drizzle-kit runs this standalone at
    // `drizzle-kit generate` time and cannot use the Effect runtime loader.
    url: process.env.SAGA_DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
