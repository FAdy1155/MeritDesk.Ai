-- NOT VALID avoids rejecting historical rows in deployment; new writes are still checked immediately.
CREATE UNIQUE INDEX "clients_tenant_id_id_idx" ON "clients" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "matters_tenant_id_id_idx" ON "matters" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_matter_fk" FOREIGN KEY ("tenant_id","matter_id") REFERENCES "public"."matters"("tenant_id","id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "matter_parties" ADD CONSTRAINT "matter_parties_tenant_matter_fk" FOREIGN KEY ("tenant_id","matter_id") REFERENCES "public"."matters"("tenant_id","id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "matter_parties" ADD CONSTRAINT "matter_parties_tenant_client_fk" FOREIGN KEY ("tenant_id","client_id") REFERENCES "public"."clients"("tenant_id","id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_tenant_matter_fk" FOREIGN KEY ("tenant_id","matter_id") REFERENCES "public"."matters"("tenant_id","id") ON DELETE cascade ON UPDATE no action NOT VALID;
