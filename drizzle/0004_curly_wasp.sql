CREATE TABLE `upload_token` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`log_id` text NOT NULL,
	`path` text NOT NULL,
	`account_id` integer NOT NULL,
	`content_type` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`created_at` text NOT NULL
);
