import postgres from "postgres";

const TEST_DB_URL =
  "postgres://sideways:sideways@localhost:5432/sideways_test";

/**
 * Wipe all tables in the test database before the test run.
 * Preserves schema/migrations, just removes data.
 */
export async function setup() {
  const sql = postgres(TEST_DB_URL);

  // Truncate all application tables (order respects FK constraints)
  await sql`TRUNCATE
    document_versions,
    comments,
    assets,
    documents,
    sections,
    space_members,
    spaces,
    themes,
    users
    CASCADE`;

  await sql.end();
}
