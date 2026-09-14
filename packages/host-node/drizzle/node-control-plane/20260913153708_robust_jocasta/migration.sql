CREATE TABLE `authorization_catalog_state` (
	`catalog_state_id` integer PRIMARY KEY,
	`control_plane_role_version` integer NOT NULL,
	`host_role_version` integer NOT NULL,
	CONSTRAINT "authorization_catalog_state_singleton" CHECK("catalog_state_id" = 1)
);
--> statement-breakpoint
CREATE TABLE `control_plane_claim` (
	`claim_id` integer PRIMARY KEY,
	`setup_capability_hash` text,
	`initial_administrator_id` text,
	`claimed_at_epoch_ms` integer,
	CONSTRAINT `fk_control_plane_claim_initial_administrator_id_principal_principal_id_fk` FOREIGN KEY (`initial_administrator_id`) REFERENCES `principal`(`principal_id`) ON DELETE RESTRICT,
	CONSTRAINT "control_plane_claim_singleton" CHECK("claim_id" = 1)
);
--> statement-breakpoint
CREATE TABLE `control_plane_role_permission` (
	`role_id` text NOT NULL,
	`permission` text NOT NULL,
	CONSTRAINT `control_plane_role_permission_pk` PRIMARY KEY(`role_id`, `permission`),
	CONSTRAINT `fk_control_plane_role_permission_role_id_control_plane_role_role_id_fk` FOREIGN KEY (`role_id`) REFERENCES `control_plane_role`(`role_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `control_plane_role` (
	`role_id` text PRIMARY KEY,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `host_role_permission` (
	`role_id` text NOT NULL,
	`permission` text NOT NULL,
	CONSTRAINT `host_role_permission_pk` PRIMARY KEY(`role_id`, `permission`),
	CONSTRAINT `fk_host_role_permission_role_id_host_role_role_id_fk` FOREIGN KEY (`role_id`) REFERENCES `host_role`(`role_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `host_role` (
	`role_id` text PRIMARY KEY,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `host_token` (
	`token_id` text PRIMARY KEY,
	`token_hash` text NOT NULL,
	`credential_version` integer NOT NULL,
	`host_id` text NOT NULL,
	`name` text NOT NULL,
	`granted_permissions_json` text NOT NULL,
	`created_at_epoch_ms` integer NOT NULL,
	`issued_by_principal_id` text NOT NULL,
	`expires_at_epoch_ms` integer,
	`revoked_at_epoch_ms` integer,
	`revoked_by_principal_id` text,
	CONSTRAINT `fk_host_token_host_id_registered_host_host_id_fk` FOREIGN KEY (`host_id`) REFERENCES `registered_host`(`host_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_host_token_issued_by_principal_id_principal_principal_id_fk` FOREIGN KEY (`issued_by_principal_id`) REFERENCES `principal`(`principal_id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_host_token_revoked_by_principal_id_principal_principal_id_fk` FOREIGN KEY (`revoked_by_principal_id`) REFERENCES `principal`(`principal_id`) ON DELETE RESTRICT,
	CONSTRAINT "host_token_credential_version_v1" CHECK("credential_version" = 1),
	CONSTRAINT "host_token_revocation_pair" CHECK(("revoked_at_epoch_ms" IS NULL AND "revoked_by_principal_id" IS NULL) OR ("revoked_at_epoch_ms" IS NOT NULL AND "revoked_by_principal_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `local_identity` (
	`identity_id` integer PRIMARY KEY,
	`principal_id` text NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at_epoch_ms` integer NOT NULL,
	CONSTRAINT `fk_local_identity_principal_id_principal_principal_id_fk` FOREIGN KEY (`principal_id`) REFERENCES `principal`(`principal_id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `local_principal_credential` (
	`credential_id` integer PRIMARY KEY,
	`principal_id` text NOT NULL,
	`credential_version` integer NOT NULL,
	`credential_hash` text NOT NULL,
	`created_at_epoch_ms` integer NOT NULL,
	CONSTRAINT `fk_local_principal_credential_principal_id_principal_principal_id_fk` FOREIGN KEY (`principal_id`) REFERENCES `principal`(`principal_id`) ON DELETE RESTRICT,
	CONSTRAINT "local_principal_credential_version_v1" CHECK("credential_version" = 1)
);
--> statement-breakpoint
CREATE TABLE `principal_control_plane_role` (
	`principal_id` text NOT NULL,
	`role_id` text NOT NULL,
	CONSTRAINT `principal_control_plane_role_pk` PRIMARY KEY(`principal_id`, `role_id`),
	CONSTRAINT `fk_principal_control_plane_role_principal_id_principal_principal_id_fk` FOREIGN KEY (`principal_id`) REFERENCES `principal`(`principal_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_principal_control_plane_role_role_id_control_plane_role_role_id_fk` FOREIGN KEY (`role_id`) REFERENCES `control_plane_role`(`role_id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `principal_host_membership` (
	`host_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`created_at_epoch_ms` integer NOT NULL,
	CONSTRAINT `principal_host_membership_pk` PRIMARY KEY(`host_id`, `principal_id`),
	CONSTRAINT `fk_principal_host_membership_host_id_registered_host_host_id_fk` FOREIGN KEY (`host_id`) REFERENCES `registered_host`(`host_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_principal_host_membership_principal_id_principal_principal_id_fk` FOREIGN KEY (`principal_id`) REFERENCES `principal`(`principal_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `principal_host_role` (
	`host_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`role_id` text NOT NULL,
	CONSTRAINT `principal_host_role_pk` PRIMARY KEY(`host_id`, `principal_id`, `role_id`),
	CONSTRAINT `fk_principal_host_role_role_id_host_role_role_id_fk` FOREIGN KEY (`role_id`) REFERENCES `host_role`(`role_id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_principal_host_role_host_id_principal_id_principal_host_membership_host_id_principal_id_fk` FOREIGN KEY (`host_id`,`principal_id`) REFERENCES `principal_host_membership`(`host_id`,`principal_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `principal` (
	`principal_id` text PRIMARY KEY,
	`created_at_epoch_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `registered_host` (
	`host_id` text PRIMARY KEY,
	`created_at_epoch_ms` integer NOT NULL
);
--> statement-breakpoint
-- schema_migration is created and owned by Drizzle's migrator before this
-- migration runs. Its matching declaration remains in the TypeScript schema so
-- checked generation tracks the physical table without trying to create it twice.
CREATE UNIQUE INDEX `host_token_hash_unique` ON `host_token` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `local_identity_principal_unique` ON `local_identity` (`principal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `local_identity_username_unique` ON `local_identity` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `local_principal_credential_principal_unique` ON `local_principal_credential` (`principal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `local_principal_credential_hash_unique` ON `local_principal_credential` (`credential_hash`);