import { getStoredCredentials } from "./auth.js";

/**
 * Thin API client for the Sideways server.
 */

export function createClient(baseUrl: string, actorName?: string) {
  async function request(path: string, options?: RequestInit) {
    const creds = getStoredCredentials();
    const authHeaders: Record<string, string> = {};
    if (creds?.api_key) {
      authHeaders["Authorization"] = `Bearer ${creds.api_key}`;
    }
    // Actor override: --as flag > SIDEWAYS_ACTOR env var
    const actor = actorName || process.env.SIDEWAYS_ACTOR;
    if (actor) {
      authHeaders["X-Sideways-Actor"] = actor;
    }

    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
        ...options?.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      let message: string;
      try {
        const parsed = JSON.parse(body);
        message = parsed.error || body;
      } catch {
        message = body;
      }

      // Friendly messages for common errors
      if (res.status === 404) {
        if (message.includes("Space")) {
          console.error(`Space not found. Does it exist on the server?`);
        } else if (message.includes("Not found")) {
          console.error(`Not found: ${path}`);
        } else {
          console.error(`Not found: ${message}`);
        }
        process.exit(1);
      }
      if (res.status === 401) {
        console.error("Not authenticated. Run `sideways login` first.");
        process.exit(1);
      }
      if (res.status === 403) {
        console.error("Permission denied. You may need to be a space member.");
        process.exit(1);
      }

      throw new Error(`API error ${res.status}: ${message}`);
    }

    return res.json();
  }

  return {
    listSpaces() {
      return request("/api/spaces");
    },

    getSpace(slug: string) {
      return request(`/api/spaces/${slug}`);
    },

    listDocuments(space: string) {
      return request(`/api/documents?space=${space}`);
    },

    getDocument(space: string, slug: string) {
      return request(`/api/documents/${space}/${slug}`);
    },

    putDocument(
      space: string,
      slug: string,
      body: { title?: string; content?: string; tags?: string[]; sectionSlug?: string; parentSlug?: string; updatedAt?: string },
    ) {
      return request(`/api/documents/${space}/${slug}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    },

    patchDocument(space: string, slug: string, patch: Record<string, any>) {
      return request(`/api/documents/${space}/${slug}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
    },

    duplicateDocument(space: string, slug: string, opts?: { targetSpace?: string; targetSlug?: string }) {
      return request(`/api/documents/${space}/${slug}/duplicate`, {
        method: "POST",
        body: JSON.stringify(opts || {}),
      });
    },

    deleteDocument(space: string, slug: string) {
      return request(`/api/documents/${space}/${slug}`, {
        method: "DELETE",
      });
    },

    /** Check if a space exists. Returns false on 404, throws on other errors. */
    async spaceExists(space: string): Promise<boolean> {
      const creds = getStoredCredentials();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (creds?.api_key) headers["Authorization"] = `Bearer ${creds.api_key}`;

      const res = await fetch(`${baseUrl}/api/spaces/${space}`, { headers });
      if (res.status === 404) return false;
      if (!res.ok) return false;
      return true;
    },

    getSyncInfo(space: string, section?: string) {
      const qs = section ? `?section=${section}` : "";
      return request(`/api/documents/${space}/_sync${qs}`);
    },

    createSpace(slug: string, name?: string, visibility: string = "private") {
      return request(`/api/spaces/${slug}`, {
        method: "PUT",
        body: JSON.stringify({ name: name || slug, visibility }),
      });
    },

    updateSpace(slug: string, updates: Record<string, any>) {
      return request(`/api/spaces/${slug}`, {
        method: "PUT",
        body: JSON.stringify(updates),
      });
    },

    getSpaceMembers(slug: string) {
      return request(`/api/spaces/${slug}/members`);
    },

    addSpaceMember(slug: string, email: string, role: string) {
      return request(`/api/spaces/${slug}/members`, {
        method: "PUT",
        body: JSON.stringify({ email, role }),
      });
    },

    removeSpaceMember(slug: string, memberId: string) {
      return request(`/api/spaces/${slug}/members/${memberId}`, {
        method: "DELETE",
      });
    },

    deleteSpace(slug: string) {
      return request(`/api/spaces/${slug}`, { method: "DELETE" });
    },

    listSections(space: string) {
      return request(`/api/spaces/${space}/sections`);
    },

    createSection(space: string, slug: string, title?: string) {
      return request(`/api/spaces/${space}/sections/${slug}`, {
        method: "PUT",
        body: JSON.stringify({ title: title || slug }),
      });
    },

    getVersions(space: string, slug: string) {
      return request(`/api/documents/${space}/${slug}/versions`);
    },

    getComments(space: string, slug: string, includeResolved = false) {
      const qs = includeResolved ? "?include_resolved=true" : "";
      return request(`/api/comments/${space}/${slug}${qs}`);
    },

    addComment(space: string, slug: string, body: {
      body: string;
      anchorText?: string;
      anchorSection?: string;
      parentId?: string;
    }) {
      return request(`/api/comments/${space}/${slug}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    resolveComment(space: string, slug: string, commentId: string) {
      return request(`/api/comments/${space}/${slug}/${commentId}/resolve`, {
        method: "POST",
      });
    },

    listKeys() {
      return request("/api/keys");
    },

    deleteKey(id: string) {
      return request(`/api/keys/${id}`, { method: "DELETE" });
    },

    /** Download PDF — returns raw Response (not parsed JSON) */
    async downloadPdf(
      space: string,
      slug: string,
      opts?: { toc?: boolean; titlePage?: boolean },
    ): Promise<Response> {
      const creds = getStoredCredentials();
      const headers: Record<string, string> = {};
      if (creds?.api_key) headers["Authorization"] = `Bearer ${creds.api_key}`;

      const params = new URLSearchParams();
      if (opts?.toc === false) params.set("toc", "false");
      if (opts?.titlePage === false) params.set("title-page", "false");
      const qs = params.toString() ? `?${params}` : "";

      const res = await fetch(
        `${baseUrl}/api/documents/${space}/${slug}/pdf${qs}`,
        { headers },
      );

      if (!res.ok) {
        const body = await res.text();
        if (res.status === 404) {
          console.error("Document not found.");
          process.exit(1);
        }
        if (res.status === 503) {
          console.error("PDF service unavailable. Is WeasyPrint running?");
          process.exit(1);
        }
        throw new Error(`PDF export failed (${res.status}): ${body}`);
      }

      return res;
    },
  };
}
