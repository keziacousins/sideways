/**
 * One-shot migration for the paths-and-sections refactor.
 *
 * - Adds `documents.path` (nullable).
 * - Ensures every space has a `default` section.
 * - Reassigns sectionless documents to their space's default section.
 * - Backfills empty paths with `<slug>.md`.
 * - Promotes `documents.path` and `documents.section_id` to NOT NULL.
 *
 * Idempotent — safe to run repeatedly. Runs before `drizzle-kit push` so the
 * schema sync sees a populated, constraint-ready table.
 *
 * Usage: tsx scripts/migrate-paths-sections.ts
 * Requires DATABASE_URL in environment.
 */

import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

const sql = postgres(DATABASE_URL);

async function main() {
  console.log("==> migrate-paths-sections starting");

  // 1. Add documents.path nullable if missing.
  await sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS path text`;
  console.log("    ensured documents.path column exists");

  // 2. Ensure every space has a `default` section.
  const inserted = await sql`
    INSERT INTO sections (space_id, slug, title, position)
    SELECT s.id, 'default', 'Default', 0
    FROM spaces s
    WHERE NOT EXISTS (
      SELECT 1 FROM sections sec
      WHERE sec.space_id = s.id AND sec.slug = 'default'
    )
    RETURNING space_id
  `;
  console.log(`    created default section for ${inserted.length} space(s)`);

  // 3. Reassign sectionless docs to their space's default section.
  const reassigned = await sql`
    UPDATE documents d
    SET section_id = sec.id
    FROM sections sec
    WHERE d.section_id IS NULL
      AND sec.space_id = d.space_id
      AND sec.slug = 'default'
    RETURNING d.id
  `;
  console.log(`    reassigned ${reassigned.length} sectionless document(s) to default`);

  // 4. Backfill empty paths with `<slug>.md`.
  const backfilled = await sql`
    UPDATE documents
    SET path = slug || '.md'
    WHERE path IS NULL
    RETURNING id
  `;
  console.log(`    backfilled path for ${backfilled.length} document(s)`);

  // 5. Promote constraints to NOT NULL.
  await sql`ALTER TABLE documents ALTER COLUMN section_id SET NOT NULL`;
  await sql`ALTER TABLE documents ALTER COLUMN path SET NOT NULL`;
  console.log("    promoted section_id and path to NOT NULL");

  console.log("==> migrate-paths-sections done");
  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
