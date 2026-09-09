// The index is a read model, not a normalised domain. A release keeps its
// whole validated document in one column; only what is sorted or filtered
// on gets a column of its own (spec §4).

import { sqliteTable, text, integer, blob, primaryKey } from 'drizzle-orm/sqlite-core';

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
});

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
