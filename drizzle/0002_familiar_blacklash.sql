CREATE TABLE `account` (
	`github_user_id` integer PRIMARY KEY NOT NULL,
	`login` text NOT NULL,
	`avatar_url` text,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `allowlist` (
	`github_login` text PRIMARY KEY NOT NULL,
	`added_by` text NOT NULL,
	`added_at` text NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE TABLE `repo_permission` (
	`account_id` integer NOT NULL,
	`log_id` text NOT NULL,
	`can_write` integer NOT NULL,
	`checked_at` text NOT NULL,
	PRIMARY KEY(`account_id`, `log_id`)
);
