-- Full-text search: tsvector column on documents with GIN index
ALTER TABLE "documents" ADD COLUMN "search_tsv" tsvector;
--> statement-breakpoint
CREATE INDEX "documents_search_idx" ON "documents" USING GIN ("search_tsv");
--> statement-breakpoint

-- Backfill: compute weighted tsvector from title + tags + latest content
UPDATE documents d SET search_tsv =
  setweight(to_tsvector('english', d.title), 'A') ||
  setweight(to_tsvector('english', COALESCE(array_to_string(d.tags, ' '), '')), 'B') ||
  setweight(to_tsvector('english', COALESCE(dv.content, '')), 'C')
FROM (
  SELECT DISTINCT ON (document_id) document_id, content
  FROM document_versions
  ORDER BY document_id, version DESC
) dv
WHERE d.id = dv.document_id;
