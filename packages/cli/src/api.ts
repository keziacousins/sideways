import type { Document, Section, Space } from "@sideways/types";
import { getStoredCredentials } from "./auth.js";

/**
 * Thin API client for the Sideways server.
 */

/** A single entry from /api/documents/{space}/_sync */
export interface SyncInfo {
  id: string;
  title: string;
  sectionSlug: string;
  path: string;
  url: string;
  version: number;
  contentHash: string;
  updatedAt: string;
}

/** A document with its current content (GET /api/documents/{space}/{section}/{path}) */
export interface DocumentWithContent extends Document {
  content: string;
  version: number;
  contentHash: string;
  sectionSlug: string;
  parentId: string | null;
  url: string;
}

/** Comment payload returned by the server */
export interface CommentResponse {
  id: string;
  body: string;
  author: { id: string; name: string; email: string } | null;
  createdAt: string;
  anchorText: string | null;
  anchorSection: string | null;
  anchorContext: string | null;
  parentId: string | null;
  resolved: boolean;
}

/** Space member with joined user fields (name/email) */
export interface SpaceMemberResponse {
  id: string;
  userId: string;
  role: "viewer" | "editor" | "admin";
  name: string;
  email: string;
}

/** API key summary returned by /api/keys */
export interface ApiKeySummary {
  id: string;
  name: string | null;
  prefix: string;
  actorName: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/** A printable theme summary returned by /api/themes */
export interface ThemeSummary {
  id: string;
  name: string;
}

export function createClient(baseUrl: string, actorName?: string) {
  async function request<T = unknown>(path: string, options?: RequestInit): Promise<T> {
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

    if (res.status === 204) return undefined as T;
    return res.json();
  }

  return {
    listSpaces() {
      return request<Space[]>("/api/spaces");
    },

    getSpace(slug: string) {
      return request<Space>(`/api/spaces/${slug}`);
    },

    listDocuments(space: string) {
      return request<(Document & { sectionSlug: string; url: string })[]>(`/api/documents?space=${space}`);
    },

    getDocument(space: string, sectionSlug: string, path: string) {
      return request<DocumentWithContent>(`/api/documents/${space}/${sectionSlug}/${path}`);
    },

    putDocument(
      space: string,
      sectionSlug: string,
      path: string,
      body: { title?: string; content?: string; tags?: string[]; parentPath?: string; updatedAt?: string },
    ) {
      return request<DocumentWithContent>(`/api/documents/${space}/${sectionSlug}/${path}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    },

    patchDocument(
      space: string,
      sectionSlug: string,
      path: string,
      patch: Record<string, any>,
    ) {
      return request<DocumentWithContent>(`/api/documents/${space}/${sectionSlug}/${path}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
    },

    duplicateDocument(
      space: string,
      sectionSlug: string,
      path: string,
      opts?: { targetSpace?: string; targetSection?: string; targetPath?: string },
    ) {
      return request<DocumentWithContent>(
        `/api/documents/${space}/${sectionSlug}/_duplicate/${path}`,
        { method: "POST", body: JSON.stringify(opts || {}) },
      );
    },

    deleteDocument(space: string, sectionSlug: string, path: string) {
      return request<void>(`/api/documents/${space}/${sectionSlug}/${path}`, {
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
      return request<SyncInfo[]>(`/api/documents/${space}/_sync${qs}`);
    },

    getCommentCounts(space: string) {
      return request<Array<{ sectionSlug: string; path: string; count: number }>>(
        `/api/documents/${space}/_comment-counts`,
      );
    },

    createSpace(slug: string, name?: string, visibility: string = "private") {
      return request<Space>(`/api/spaces/${slug}`, {
        method: "PUT",
        body: JSON.stringify({ name: name || slug, visibility }),
      });
    },

    updateSpace(slug: string, updates: Record<string, any>) {
      return request<Space>(`/api/spaces/${slug}`, {
        method: "PUT",
        body: JSON.stringify(updates),
      });
    },

    getSpaceMembers(slug: string) {
      return request<SpaceMemberResponse[]>(`/api/spaces/${slug}/members`);
    },

    addSpaceMember(slug: string, email: string, role: string) {
      return request<SpaceMemberResponse>(`/api/spaces/${slug}/members`, {
        method: "PUT",
        body: JSON.stringify({ email, role }),
      });
    },

    removeSpaceMember(slug: string, memberId: string) {
      return request<void>(`/api/spaces/${slug}/members/${memberId}`, {
        method: "DELETE",
      });
    },

    deleteSpace(slug: string) {
      return request<void>(`/api/spaces/${slug}`, { method: "DELETE" });
    },

    listSections(space: string) {
      return request<Section[]>(`/api/spaces/${space}/sections`);
    },

    createSection(space: string, slug: string, title?: string) {
      return request<Section>(`/api/spaces/${space}/sections/${slug}`, {
        method: "PUT",
        body: JSON.stringify({ title: title || slug }),
      });
    },

    putSection(space: string, slug: string, body: { title?: string; position?: number }) {
      return request<Section>(`/api/spaces/${space}/sections/${slug}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    },

    getVersions(space: string, sectionSlug: string, path: string) {
      return request<Array<{ version: number; contentHash: string; createdAt: string; createdBy: string }>>(
        `/api/documents/${space}/${sectionSlug}/_versions/${path}`,
      );
    },

    getComments(space: string, sectionSlug: string, path: string, includeResolved = false) {
      const qs = includeResolved ? "?include_resolved=true" : "";
      return request<CommentResponse[]>(`/api/comments/${space}/${sectionSlug}/${path}${qs}`);
    },

    addComment(
      space: string,
      sectionSlug: string,
      path: string,
      body: {
        body: string;
        anchorText?: string;
        anchorSection?: string;
        parentId?: string;
      },
    ) {
      return request<CommentResponse>(`/api/comments/${space}/${sectionSlug}/${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    resolveComment(commentId: string) {
      return request<CommentResponse>(`/api/comments/${commentId}/resolve`, {
        method: "POST",
      });
    },

    listKeys() {
      return request<ApiKeySummary[]>("/api/keys");
    },

    listThemes() {
      return request<ThemeSummary[]>("/api/themes");
    },

    deleteKey(id: string) {
      return request<void>(`/api/keys/${id}`, { method: "DELETE" });
    },

    /** Download PDF — returns raw Response (not parsed JSON) */
    async downloadPdf(
      space: string,
      sectionSlug: string,
      path: string,
      opts?: { toc?: boolean; titlePage?: boolean; theme?: string },
    ): Promise<Response> {
      const creds = getStoredCredentials();
      const headers: Record<string, string> = {};
      if (creds?.api_key) headers["Authorization"] = `Bearer ${creds.api_key}`;

      const params = new URLSearchParams();
      if (opts?.toc === false) params.set("toc", "false");
      if (opts?.titlePage === false) params.set("title-page", "false");
      if (opts?.theme) params.set("theme", opts.theme);
      const qs = params.toString() ? `?${params}` : "";

      const res = await fetch(
        `${baseUrl}/api/documents/${space}/${sectionSlug}/_pdf/${path}${qs}`,
        { headers },
      );

      if (!res.ok) {
        const body = await res.text();
        if (res.status === 404) {
          let message = "Not found.";
          try { message = JSON.parse(body).error || message; } catch {}
          console.error(message);
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
