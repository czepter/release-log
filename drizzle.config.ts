// drizzle-kit reads this to generate migrations from the schema.
// It is tooling config, never imported by the service.
import type { Config } from 'drizzle-kit';

export default {
  schema: './lib/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
} satisfies Config;
