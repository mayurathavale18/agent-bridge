import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { coerceValues, fieldDescriptors } from '../core/config-schema.ts';
import type { ConfigStore } from '../core/config-store.ts';
import { HARNESS_CATALOG, resolveHarnessConfig, type CatalogEntry } from '../harnesses/catalog.ts';
import { DASHBOARD_HTML } from './page.ts';

export interface DashboardOptions {
  config: ConfigStore;
  workspace: string;
  /** Overridable for tests. */
  catalog?: CatalogEntry[];
  env?: NodeJS.ProcessEnv;
  /** Extra status shown in the header (e.g. session count). */
  statusLine?: () => string;
  log?: (message: string) => void;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * The config dashboard: a schema-driven UI over the harness catalog.
 *
 * It renders from each manifest's `config` schema, so a plugin that declares a setting gets a
 * control for free. It reports which keys the environment is pinning, because a saved value that
 * silently loses to an env var is the single most confusing failure mode of this design.
 *
 * Unauthenticated and bound to loopback by default — it exposes configuration, so exposing it
 * beyond the host is an explicit operator decision.
 */
export class DashboardServer {
  #config: ConfigStore;
  #workspace: string;
  #catalog: CatalogEntry[];
  #env: NodeJS.ProcessEnv;
  #statusLine: () => string;
  #log: (message: string) => void;

  constructor(opts: DashboardOptions) {
    this.#config = opts.config;
    this.#workspace = opts.workspace;
    this.#catalog = opts.catalog ?? HARNESS_CATALOG;
    this.#env = opts.env ?? process.env;
    this.#statusLine = opts.statusLine ?? (() => '');
    this.#log = opts.log ?? (message => process.stdout.write(`[dashboard] ${message}\n`));
  }

  #state(): unknown {
    return {
      activeHarness: this.#activeId(),
      workspace: this.#workspace,
      statusLine: this.#statusLine(),
      harnesses: this.#catalog.map(entry => {
        const resolved = resolveHarnessConfig(entry, this.#config.harnessConfig(entry.manifest.id), this.#env);
        return {
          manifest: {
            id: entry.manifest.id,
            name: entry.manifest.name,
            version: entry.manifest.version,
            kind: entry.manifest.kind,
            capabilities: entry.manifest.capabilities,
            metadata: entry.manifest.metadata,
          },
          fields: fieldDescriptors(entry.manifest.config),
          values: resolved.values,
          pinned: resolved.pinned,
        };
      }),
    };
  }

  #activeId(): string {
    return this.#config.activeHarness ?? this.#catalog[0]?.manifest.id ?? 'mock';
  }

  handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method === 'POST' || req.method === 'PUT') {
      const origin = req.headers.origin;
      if ((origin && new URL(origin).host !== req.headers.host) ||
          !req.headers['content-type']?.startsWith('application/json')) {
        sendJson(res, 403, { errors: ['same-origin JSON request required'] });
        return;
      }
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(DASHBOARD_HTML);
      return;
    }

    if (req.method === 'GET' && path === '/api/state') {
      sendJson(res, 200, this.#state());
      return;
    }

    if (req.method === 'POST' && path === '/api/active') {
      const body = await parseJsonBody(req);
      const id = typeof body?.id === 'string' ? body.id : '';
      if (!this.#catalog.some(entry => entry.manifest.id === id)) {
        sendJson(res, 400, { errors: [`unknown harness: ${id}`] });
        return;
      }
      this.#config.setActiveHarness(id);
      this.#log(`active harness -> ${id}`);
      sendJson(res, 200, { ok: true, activeHarness: id });
      return;
    }

    const configMatch = /^\/api\/harnesses\/([^/]+)\/config$/.exec(path);
    if (configMatch && (req.method === 'PUT' || req.method === 'POST')) {
      const id = decodeURIComponent(configMatch[1] as string);
      const entry = this.#catalog.find(candidate => candidate.manifest.id === id);
      if (!entry) {
        sendJson(res, 404, { errors: [`unknown harness: ${id}`] });
        return;
      }
      const body = (await parseJsonBody(req)) ?? {};
      const { values, errors } = coerceValues(entry.manifest.config, body);
      if (errors.length > 0) {
        sendJson(res, 400, { errors });
        return;
      }
      this.#config.setHarnessConfig(id, values);
      this.#log(`saved config for ${id}: ${Object.keys(values).join(', ') || '(none)'}`);
      sendJson(res, 200, { ok: true, values });
      return;
    }

    sendJson(res, 404, { errors: ['not found'] });
  };

  start(port: number, host = '127.0.0.1'): ReturnType<typeof createServer> {
    const server = createServer((req, res) => {
      void this.handler(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { errors: ['internal error'] });
        else res.end();
      });
    });
    server.listen(port, host, () => this.#log(`listening on http://${host}:${port}`));
    return server;
  }
}

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
