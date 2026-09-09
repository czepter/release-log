CREATE TABLE `log` (
	`public_id` text PRIMARY KEY NOT NULL,
	`repo_owner` text NOT NULL,
	`repo_name` text NOT NULL,
	`repo_node_id` text,
	`product` text NOT NULL,
	`view` text NOT NULL,
	`visibility` text NOT NULL,
	`curation_notes` text,
	`state` text NOT NULL,
	`head_sha` text,
	`config_blob_sha` text,
	`indexed_at` text
);
--> statement-breakpoint
CREATE TABLE `media` (
	`log_id` text NOT NULL,
	`path` text NOT NULL,
	`blob_sha` text NOT NULL,
	`content_type` text NOT NULL,
	`bytes` blob NOT NULL,
	PRIMARY KEY(`log_id`, `path`)
);
--> statement-breakpoint
CREATE TABLE `problem` (
	`path` text PRIMARY KEY NOT NULL,
	`message` text NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `release` (
	`log_id` text NOT NULL,
	`version` text NOT NULL,
	`date` text NOT NULL,
	`published_at` text,
	`blob_sha` text NOT NULL,
	`path` text NOT NULL,
	`doc` text NOT NULL,
	PRIMARY KEY(`log_id`, `version`)
);
--> statement-breakpoint
CREATE TABLE `sync_error` (
	`log_id` text NOT NULL,
	`path` text NOT NULL,
	`message` text NOT NULL,
	`at` text NOT NULL,
	PRIMARY KEY(`log_id`, `path`)
);
