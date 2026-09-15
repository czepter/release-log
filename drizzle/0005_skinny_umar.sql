CREATE TABLE `github_user_token` (
	`account_id` integer PRIMARY KEY NOT NULL,
	`access_token_enc` text NOT NULL,
	`access_expires_at` text,
	`refresh_token_enc` text,
	`refresh_expires_at` text,
	`updated_at` text NOT NULL
);
