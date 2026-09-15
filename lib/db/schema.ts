// The index is a read model, not a normalised domain. A release keeps its
// whole validated document in one column; only what is sorted or filtered
// on gets a column of its own (spec §4).

import { sqliteTable, text, integer, blob, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const log = sqliteTable('log', {
  publicId: text('public_id').primaryKey(),
  repoOwner: text('repo_owner').notNull(),
  repoName: text('repo_name').notNull(),
  // GitHub's immutable repo id. It survives a rename or a transfer, which
  // is why the index anchors on it rather than on owner/name (spec §10).
  repoNodeId: text('repo_node_id'),
  product: text('product').notNull(),
  view: text('view').notNull(),
  visibility: text('visibility').notNull(),
  curationNotes: text('curation_notes'),
  // 'active' | 'frozen'. A deleted repo freezes its log: the last state
  // stays served, nothing syncs (spec §10).
  state: text('state').notNull(),
  headSha: text('head_sha'),
  configBlobSha: text('config_blob_sha'),
  indexedAt: text('indexed_at'),
}, (t) => [
  // One log per repository (spec §4): the database enforces it rather
  // than relying on syncLog to remember to clean up after itself when a
  // repository's id changes.
  uniqueIndex('log_repo_owner_repo_name_unique').on(t.repoOwner, t.repoName),
]);

export const release = sqliteTable('release', {
  logId: text('log_id').notNull(),
  version: text('version').notNull(),
  date: text('date').notNull(),
  publishedAt: text('published_at'),
  blobSha: text('blob_sha').notNull(),
  path: text('path').notNull(),
  doc: text('doc').notNull(),
}, (t) => [primaryKey({ columns: [t.logId, t.version] })]);

export const media = sqliteTable('media', {
  logId: text('log_id').notNull(),
  path: text('path').notNull(),
  blobSha: text('blob_sha').notNull(),
  contentType: text('content_type').notNull(),
  bytes: blob('bytes', { mode: 'buffer' }).notNull(),
}, (t) => [primaryKey({ columns: [t.logId, t.path] })]);

export const syncError = sqliteTable('sync_error', {
  logId: text('log_id').notNull(),
  path: text('path').notNull(),
  message: text('message').notNull(),
  at: text('at').notNull(),
}, (t) => [primaryKey({ columns: [t.logId, t.path] })]);

// Problems with no log id to key them by: an unparseable release-log.json
// and a duplicate id. Keyed by repo path instead (spec §3, §10).
export const problem = sqliteTable('problem', {
  path: text('path').primaryKey(),
  message: text('message').notNull(),
  at: text('at').notNull(),
});

// Whoever has signed in successfully. Admin right is not a column here —
// it is ADMIN_LOGINS from the environment, checked fresh every time, never
// stored (spec §5).
export const account = sqliteTable('account', {
  githubUserId: integer('github_user_id').primaryKey(),
  login: text('login').notNull(),
  avatarUrl: text('avatar_url'),
  lastSeenAt: text('last_seen_at').notNull(),
});

// Who may sign in at all, beyond ADMIN_LOGINS. Starts empty; nothing in
// this plan writes to it yet — only a future admin UI (Plan 6) does.
export const allowlist = sqliteTable('allowlist', {
  githubLogin: text('github_login').primaryKey(),
  addedBy: text('added_by').notNull(),
  addedAt: text('added_at').notNull(),
  note: text('note'),
});

// A cached answer to "does this account have write access to this log's
// repository", good for five minutes (spec §5). Keyed by the pair, not by
// account alone: one person can hold different rights on different logs.
export const repoPermission = sqliteTable('repo_permission', {
  accountId: integer('account_id').notNull(),
  logId: text('log_id').notNull(),
  canWrite: integer('can_write', { mode: 'boolean' }).notNull(),
  checkedAt: text('checked_at').notNull(),
}, (t) => [primaryKey({ columns: [t.accountId, t.logId] })]);

// Ein registrierter MCP-Client (RFC 7591, Dynamic Client Registration).
// Ausschließlich öffentliche Clients -- kein Secret, PKCE ist die einzige
// Client-Authentisierung (spec §5, Abweichung 2).
export const oauthClient = sqliteTable('oauth_client', {
  clientId: text('client_id').primaryKey(),
  clientName: text('client_name').notNull(),
  // JSON-Array von Strings. Eine eigene Tabelle für mehrere Redirect-URIs
  // wäre für "ein paar Strings, nie einzeln abgefragt" die falsche Naht.
  redirectUris: text('redirect_uris').notNull(),
  createdAt: text('created_at').notNull(),
});

// Ein ausgegebener, noch nicht eingelöster Autorisierungscode. Einmalig,
// 60 Sekunden gültig (spec §5). Der Code selbst wird nie gespeichert, nur
// sein Hash -- wie jedes andere Token in diesem System.
export const oauthCode = sqliteTable('oauth_code', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  // Eine zweite Einlösung widerruft alle aus diesem Code entstandenen Token
  // (spec §5) -- familyId bindet Code und die daraus geprägten Token an
  // dieselbe widerrufbare Kette, von Anfang an, nicht erst beim Refresh.
  familyId: text('family_id').notNull(),
  accountId: integer('account_id').notNull(),
  scope: text('scope').notNull(),
  expiresAt: text('expires_at').notNull(),
  consumedAt: text('consumed_at'),
});

// Ein ausgegebenes Access- oder Refresh-Token. Nur der Hash liegt in der
// Datenbank (spec §5) -- was hier steht, reicht zum Prüfen, nicht zum
// Benutzen. familyId gruppiert jede Rotation eines Refresh-Tokens und sein
// zugehöriges Access-Token; ein Widerruf trifft immer die ganze familyId.
export const oauthToken = sqliteTable('oauth_token', {
  id: text('id').primaryKey(),
  familyId: text('family_id').notNull(),
  clientId: text('client_id').notNull(),
  accountId: integer('account_id').notNull(),
  scope: text('scope').notNull(),
  kind: text('kind').notNull(), // 'access' | 'refresh'
  tokenHash: text('token_hash').notNull(),
  expiresAt: text('expires_at').notNull(),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').notNull(),
}, (t) => [
  uniqueIndex('oauth_token_hash_unique').on(t.tokenHash),
]);
