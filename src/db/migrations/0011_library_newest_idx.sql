-- The library search with filters and no words (src/services/library/search.ts)
-- lists the newest documents first, ordered by
-- coalesce(decision_date, published_date, effective_date) desc nulls last,
-- first_seen_at desc. This index serves that order, so the planner can read
-- the first rows of the index instead of sorting the whole table.
CREATE INDEX "library_documents_newest_idx" ON "library_documents" USING btree (coalesce("decision_date", "published_date", "effective_date") desc nulls last,"first_seen_at" DESC NULLS FIRST);