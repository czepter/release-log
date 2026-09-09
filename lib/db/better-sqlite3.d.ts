// better-sqlite3 ships no type declarations, and adding @types/better-sqlite3
// would be a new devDependency outside what this plan allows. This ambient
// shim satisfies tsc; drizzle-orm's own bundled types (skipped via
// skipLibCheck) carry the real shape once values cross into drizzle().
declare module 'better-sqlite3';
