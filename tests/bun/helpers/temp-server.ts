export interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyText: string;
}

export interface CaptureServerOptions {
  postStatus?: number;
  postBody?: Record<string, unknown>;
}

export interface CaptureServer {
  baseUrl: string;
  requests: CapturedRequest[];
  stop(): Promise<void>;
}

export async function startCaptureServer(options: CaptureServerOptions = {}): Promise<CaptureServer> {
  const requests: CapturedRequest[] = [];
  const postStatus = options.postStatus ?? 201;
  const postBody = options.postBody ?? {
    artifactId: "artifact-from-test",
    expiresAt: "2099-01-01T00:00:00Z",
  };

  const server = Bun.serve({
    port: 0,
    async fetch(request: Request) {
      const bodyText = await request.text();
      const headerEntries = Object.fromEntries(request.headers.entries());

      requests.push({
        method: request.method,
        url: request.url,
        headers: headerEntries,
        bodyText,
      });

      if (request.method === "POST") {
        return Response.json(postBody, { status: postStatus });
      }

      return Response.json({ error: `Unexpected method ${request.method}` }, { status: 405 });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}/drop/api`,
    requests,
    async stop(): Promise<void> {
      server.stop(true);
    },
  };
}
