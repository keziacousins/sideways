/**
 * Thin API client for the Sideways server.
 */

export function createClient(baseUrl: string) {
  async function request(path: string, options?: RequestInit) {
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`API error ${res.status}: ${body}`);
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
      body: { title?: string; content?: string; tags?: string[] },
    ) {
      return request(`/api/documents/${space}/${slug}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    },

    deleteDocument(space: string, slug: string) {
      return request(`/api/documents/${space}/${slug}`, {
        method: "DELETE",
      });
    },

    getVersions(space: string, slug: string) {
      return request(`/api/documents/${space}/${slug}/versions`);
    },
  };
}
