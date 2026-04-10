/**
 * Seed built-in themes into the database.
 * Idempotent — upserts by name, safe to run repeatedly.
 *
 * Usage: tsx scripts/seed-themes.ts
 * Requires DATABASE_URL in environment (or .env).
 */

import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

const sql = postgres(DATABASE_URL);

interface BuiltInTheme {
  name: string;
  tokens: Record<string, unknown>;
}

const builtInThemes: BuiltInTheme[] = [
  {
    name: "CV / Resume",
    tokens: {
      fonts: {
        display: "Oswald",
        displayWeight: "500",
        body: "EB Garamond",
      },
      colors: {
        accent: "#2b5797",
        text: "#1a1a1a",
        mutedText: "#555",
        rule: "#ccc",
      },
      print: {
        compact: true,
        defaultTitlePage: false,
        defaultToc: false,
        margins: "1.5cm 2cm",
      },
    },
  },
];

async function seed() {
  for (const theme of builtInThemes) {
    const existing = await sql`
      SELECT id FROM themes WHERE name = ${theme.name} LIMIT 1
    `;

    if (existing.length > 0) {
      await sql`
        UPDATE themes
        SET tokens = ${JSON.stringify(theme.tokens)}::jsonb,
            updated_at = now()
        WHERE id = ${existing[0].id}
      `;
      console.log(`Updated theme: ${theme.name}`);
    } else {
      await sql`
        INSERT INTO themes (id, name, tokens)
        VALUES (gen_random_uuid(), ${theme.name}, ${JSON.stringify(theme.tokens)}::jsonb)
      `;
      console.log(`Created theme: ${theme.name}`);
    }
  }

  await sql.end();
  console.log("Done.");
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
