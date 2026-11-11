/**
 * One Durable Object instance serialises every browser run and collapses
 * concurrent identical requests, so the account never exceeds the Browser
 * Rendering concurrency limit.
 */

import { driveAnyFamily, closeBrowser, withTimeout } from './microsoft.mjs';

const CACHE_TTL_MS = 10 * 60 * 1000;

export class Coordinator {
    constructor(state, env) {
        this.env = env;
        this.cache = new Map();
        this.inflight = new Map();
        this.queue = Promise.resolve();
    }

    cached(key) {
        const hit = this.cache.get(key);
        if (!hit) return null;
        if (Date.now() - hit.at > CACHE_TTL_MS) {
            this.cache.delete(key);
            return null;
        }
        return hit.value;
    }

    /** Runs browser work one at a time. */
    enqueue(task) {
        const run = this.queue.then(task, task);
        this.queue = run.catch(() => {});
        return run;
    }

    async fetch(request) {
        const task = await request.json();
        const key = JSON.stringify(task);
        const hit = this.cached(key);
        if (hit) return Response.json({ payload: hit, cached: true });

        let promise = this.inflight.get(key);
        if (!promise) {
            promise = this.enqueue(async () => {
                const result = await withTimeout(
                    driveAnyFamily(this.env, task),
                    50_000,
                    'Browser run timed out',
                );
                const payload =
                    task.skuId
                        ? {
                              ProductDownloadOptions: (result.links ?? []).map((link) => ({
                                  Name: link.name,
                                  Uri: link.uri,
                                  DownloadType: /arm64/i.test(link.uri) ? 1 : 0,
                              })),
                          }
                        : {
                              ValidationContainer: { Errors: [] },
                              Skus: (result.languages ?? []).map((entry) => {
                                  let id = entry.value;
                                  try {
                                      id = JSON.parse(entry.value).id ?? entry.value;
                                  } catch {
                                      /* value is already the id */
                                  }
                                  return { Id: String(id), LocalizedLanguage: entry.label, Language: entry.label };
                              }),
                          };

                if (task.skuId ? payload.ProductDownloadOptions.length > 0 : payload.Skus.length > 0) {
                    this.cache.set(key, { at: Date.now(), value: payload });
                }
                return payload;
            }).finally(() => this.inflight.delete(key));

            this.inflight.set(key, promise);
        }

        const payload = await promise;
        return Response.json({ payload });
    }
}
