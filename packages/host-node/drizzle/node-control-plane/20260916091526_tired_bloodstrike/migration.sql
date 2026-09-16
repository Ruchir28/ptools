CREATE INDEX `host_token_page_idx` ON `host_token` (`created_at_epoch_ms`,`token_id`);--> statement-breakpoint
CREATE INDEX `host_token_host_page_idx` ON `host_token` (`host_id`,`created_at_epoch_ms`,`token_id`);--> statement-breakpoint
CREATE INDEX `principal_host_membership_principal_page_idx` ON `principal_host_membership` (`principal_id`,`host_id`);