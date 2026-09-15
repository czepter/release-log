CREATE TABLE `oauth_client` (
	`client_id` text PRIMARY KEY NOT NULL,
	`client_name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_code` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`family_id` text NOT NULL,
	`account_id` integer NOT NULL,
	`scope` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text
);
--> statement-breakpoint
CREATE TABLE `oauth_token` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`client_id` text NOT NULL,
	`account_id` integer NOT NULL,
	`scope` text NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_token_hash_unique` ON `oauth_token` (`token_hash`);