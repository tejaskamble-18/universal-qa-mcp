import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve } from 'node:path';

/**
 * Controlled sample application for the operator acceptance tests.
 * A small SPA (public/) backed by an in-memory JSON API with cookie sessions,
 * two roles, and test-only control endpoints (/__control/*) to inject network
 * failures, expire sessions and inspect what the server actually received.
 */
const PUBLIC = resolve(import.meta.dirname, 'public');
const USERS: Record<string, { password: string; role: 'admin' | 'viewer'; display: string }> = {
  admin: { password: 'admin-pass-1', role: 'admin', display: 'Ada Admin' },
  viewer: { password: 'viewer-pass-1', role: 'viewer', display: 'Vic Viewer' },
};

interface FailRule {
  method: string;
  path: RegExp;
  remaining: number;
  mode: 'status-500' | 'abort' | 'process-then-502' | 'delay';
  delayMs: number;
}

export interface SampleApp {
  url: (path?: string) => string;
  stats: () => { writes: Record<string, number>; projects: number; orders: number; uploads: number; refreshes: number; logins: number };
  fail: (rule: { method: string; path: string; times: number; mode: FailRule['mode']; delayMs?: number }) => void;
  expireSessions: () => void;
  reset: () => void;
  close: () => Promise<void>;
}

function seed() {
  return {
    projects: [
      { id: 1, name: 'Project Alpha', type: 'internal', client: '', email: '', deadline: '' },
      { id: 2, name: 'Project Beta', type: 'client', client: 'Globex', email: 'ops@globex.example', deadline: '' },
      { id: 3, name: 'Project Gamma', type: 'internal', client: '', email: '', deadline: '2031-03-01' },
    ],
    orders: [] as { id: string; plan: string; company: string; seats: number }[],
    nextProject: 4,
    nextOrder: 1001,
    uploads: 0,
    refreshes: 0,
    logins: 0,
    writes: {} as Record<string, number>,
  };
}

export async function startSampleApp(): Promise<SampleApp> {
  let db = seed();
  const sessions = new Map<string, { user: string; expires: number }>();
  let rules: FailRule[] = [];

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((ok) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => ok(Buffer.concat(chunks)));
    });
  const userOf = (req: IncomingMessage): { name: string; role: 'admin' | 'viewer'; display: string } | null => {
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const s = sid ? sessions.get(sid) : undefined;
    if (!s || s.expires < Date.now()) return null;
    const u = USERS[s.user]!;
    return { name: s.user, role: u.role, display: u.display };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();
    try {
      if (path.startsWith('/__control/')) {
        const body = method === 'POST' ? JSON.parse((await readBody(req)).toString() || '{}') : {};
        if (path === '/__control/fail') {
          rules.push({ method: body.method, path: new RegExp(body.path), remaining: body.times, mode: body.mode, delayMs: body.delayMs ?? 0 });
          return json(res, 200, { ok: true });
        }
        if (path === '/__control/expire') {
          sessions.clear();
          return json(res, 200, { ok: true });
        }
        if (path === '/__control/reset') {
          db = seed();
          rules = [];
          return json(res, 200, { ok: true });
        }
        return json(res, 404, {});
      }

      if (path.startsWith('/api/')) {
        if (method !== 'GET') db.writes[`${method} ${path.replace(/\d+/g, ':id')}`] = (db.writes[`${method} ${path.replace(/\d+/g, ':id')}`] ?? 0) + 1;
        const rule = rules.find((r) => r.remaining > 0 && r.method === method && r.path.test(path));
        let lose502 = false;
        if (rule) {
          rule.remaining--;
          if (rule.mode === 'status-500') return json(res, 500, { error: 'injected failure' });
          if (rule.mode === 'abort') {
            req.socket.destroy();
            return;
          }
          if (rule.mode === 'delay') await new Promise((r) => setTimeout(r, rule.delayMs));
          if (rule.mode === 'process-then-502') lose502 = true;
        }
        const respond = (status: number, body: unknown, headers: Record<string, string> = {}): void =>
          lose502 ? json(res, 502, { error: 'bad gateway (response lost after processing)' }) : json(res, status, body, headers);

        if (path === '/api/login' && method === 'POST') {
          const { username, password } = JSON.parse((await readBody(req)).toString() || '{}');
          const u = USERS[username];
          if (!u || u.password !== password) return respond(401, { error: 'Invalid username or password' });
          db.logins++;
          const sid = randomBytes(12).toString('hex');
          sessions.set(sid, { user: username, expires: Date.now() + 30 * 60_000 });
          return respond(200, { user: username, role: u.role }, { 'set-cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
        }
        if (path === '/api/logout' && method === 'POST') return respond(200, { ok: true }, { 'set-cookie': 'sid=; Path=/; Max-Age=0' });

        const user = userOf(req);
        if (!user) return json(res, 401, { error: 'not authenticated' });
        if (path === '/api/me') return respond(200, user);
        if (path === '/api/projects' && method === 'GET') return respond(200, db.projects);
        if (path === '/api/projects' && method === 'POST') {
          if (user.role !== 'admin') return respond(403, { error: 'forbidden' });
          const b = JSON.parse((await readBody(req)).toString() || '{}');
          if (!b.name) return respond(400, { error: 'name is required' });
          const p = { id: db.nextProject++, name: b.name, type: b.type ?? 'internal', client: b.client ?? '', email: b.email ?? '', deadline: b.deadline ?? '' };
          db.projects.push(p);
          return respond(201, p);
        }
        const pm = /^\/api\/projects\/(\d+)$/.exec(path);
        if (pm) {
          const id = Number(pm[1]);
          const p = db.projects.find((x) => x.id === id);
          if (!p) return respond(404, { error: 'not found' });
          if (method === 'DELETE') {
            if (user.role !== 'admin') return respond(403, { error: 'forbidden' });
            db.projects = db.projects.filter((x) => x.id !== id);
            return respond(200, { ok: true });
          }
          return respond(200, p);
        }
        if (path === '/api/activity') {
          await new Promise((r) => setTimeout(r, Number(url.searchParams.get('delay') ?? 0)));
          return respond(200, ['Ada created Project Gamma', 'Vic viewed Project Beta', 'Ada exported the weekly report']);
        }
        if (path === '/api/reports') {
          const page = Number(url.searchParams.get('page') ?? 1);
          await new Promise((r) => setTimeout(r, page === 1 ? 900 : 200));
          return respond(200, { page, more: page < 3, items: Array.from({ length: 15 }, (_, k) => `Report ${(page - 1) * 15 + k + 1}`) });
        }
        if (path === '/api/export.csv') {
          res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="projects.csv"' });
          return res.end(`id,name\n${db.projects.map((p) => `${p.id},${p.name}`).join('\n')}\n`);
        }
        if (path === '/api/orders' && method === 'GET') return respond(200, db.orders);
        if (path === '/api/orders' && method === 'POST') {
          const b = JSON.parse((await readBody(req)).toString() || '{}');
          const o = { id: `ORD-${db.nextOrder++}`, plan: b.plan, company: b.company, seats: Number(b.seats) };
          db.orders.push(o);
          return respond(201, o);
        }
        if (path === '/api/files' && method === 'POST') {
          const body = await readBody(req);
          db.uploads++;
          return respond(201, { size: body.length });
        }
        if (path === '/api/refresh-stats' && method === 'POST') {
          db.refreshes++;
          return respond(200, { refreshedAt: new Date().toISOString() });
        }
        return json(res, 404, { error: 'unknown endpoint' });
      }

      if (path === '/blocked') {
        res.writeHead(403, { 'content-type': 'text/html' }).end('<!doctype html><title>Access denied</title><h1>Access denied</h1><p>Your request was blocked.</p>');
        return;
      }
      const file = path === '/captcha' ? 'captcha.html' : path.startsWith('/static/') ? path.slice('/static/'.length) : 'index.html';
      const full = join(PUBLIC, file);
      if (!full.startsWith(PUBLIC)) return json(res, 403, {});
      const body = await readFile(full);
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[extname(full)] ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: (p = '/') => `http://127.0.0.1:${port}${p.startsWith('/') ? p : `/${p}`}`,
    stats: () => ({ writes: { ...db.writes }, projects: db.projects.length, orders: db.orders.length, uploads: db.uploads, refreshes: db.refreshes, logins: db.logins }),
    fail: (r) => rules.push({ method: r.method, path: new RegExp(r.path), remaining: r.times, mode: r.mode, delayMs: r.delayMs ?? 0 }),
    expireSessions: () => sessions.clear(),
    // Resets data and injected failures; sessions survive (use expireSessions to end them).
    reset: () => {
      db = seed();
      rules = [];
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
