-- The library's country filter (src/services/library/search.ts, country.ts):
-- documents that state a country carry metadata.countryKeys, and a search by
-- country tests metadata -> 'countryKeys' @> '["honduras"]'::jsonb.
CREATE INDEX "library_documents_country_keys_idx" ON "library_documents" USING gin (("metadata" -> 'countryKeys') jsonb_path_ops);
