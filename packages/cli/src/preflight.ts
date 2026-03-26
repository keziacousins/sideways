/**
 * Preflight checks that run before sync commands.
 */

export async function requireSpace(
  client: { spaceExists: (s: string) => Promise<boolean> },
  space: string,
  options?: { createHint?: boolean },
): Promise<void> {
  const exists = await client.spaceExists(space);
  if (!exists) {
    if (options?.createHint) {
      console.error(
        `Space "${space}" does not exist. Run \`sideways push\` to create it.`,
      );
    } else {
      console.error(`Space "${space}" does not exist on the server.`);
    }
    process.exit(1);
  }
}

/**
 * For push: ensure space exists, create if not.
 */
export async function ensureSpace(
  client: {
    spaceExists: (s: string) => Promise<boolean>;
    createSpace: (slug: string, name?: string, visibility?: string) => Promise<any>;
  },
  space: string,
  name?: string,
): Promise<void> {
  const exists = await client.spaceExists(space);
  if (!exists) {
    await client.createSpace(space, name);
    console.log(`Created space "${space}"`);
  }
}
