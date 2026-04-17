'use strict';

const CACHE_NAME = 'rss-reader-v2';
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/badge-72.png',
];

const CORS_PROXIES = [
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
];

// ── Install ────────────────────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// ── Activate ───────────────────────────────────────────────

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch ──────────────────────────────────────────────────
//
// HTML  → network-first  (always fresh; offline falls back to cache)
// JS/CSS/icons → stale-while-revalidate  (instant load, silent background update)
// everything else → network-first

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;

  const isHTML = url.pathname.endsWith('.html') || url.pathname.endsWith('/');
  const isShellAsset = !isHTML && APP_SHELL.some(
    p => url.pathname.endsWith(p.replace('./', ''))
  );

  if (isHTML) {
    // Network-first with cache:'no-cache' to bypass GitHub Pages' HTTP cache.
    // Conditional GET (ETag) keeps it efficient — only downloads if changed.
    const req = new Request(event.request, { cache: 'no-cache' });
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  if (isShellAsset) {
    // Stale-while-revalidate: instant from cache, silently refresh for next load.
    // On first load after a SW update the cache is empty (old cache was deleted),
    // so this falls through to a fresh network fetch automatically.
    const req = new Request(event.request, { cache: 'no-cache' });
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(event.request).then(cached => {
          const networkFetch = fetch(req).then(res => {
            if (res.ok) cache.put(event.request, res.clone());
            return res;
          }).catch(() => cached);
          return cached ?? networkFetch;
        })
      )
    );
    return;
  }

  // Everything else → network-first
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// ── Periodic Background Sync ───────────────────────────────

self.addEventListener('periodicsync', event => {
  if (event.tag === 'rss-check') {
    event.waitUntil(performBackgroundCheck());
  }
});

async function performBackgroundCheck() {
  const configResponse = await getStoredConfig();
  if (!configResponse) return;

  const { feeds, knownIds, settings } = configResponse;
  if (!settings?.notifications) return;
  if (!feeds?.length) return;

  const newArticles = [];

  await Promise.allSettled(
    feeds.filter(f => f.enabled).map(async feed => {
      try {
        const xml = await proxyFetch(feed.url);
        const articles = parseRSS(xml, feed.id, feed.name);
        const fresh = articles.filter(a => !knownIds.includes(a.id));
        newArticles.push(...fresh);
      } catch {}
    })
  );

  if (newArticles.length > 0) {
    await self.registration.showNotification('RSS Reader', {
      body: `${newArticles.length} neue Artikel verfügbar`,
      icon: './icons/icon-192.png',
      badge: './icons/badge-72.png',
      tag: 'rss-update',
      renotify: true,
      data: { url: './' },
    });

    // Notify all open clients
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client =>
      client.postMessage({ type: 'NEW_ARTICLES', count: newArticles.length })
    );
  }
}

// ── Push Notifications ─────────────────────────────────────

self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'RSS Reader', {
      body: data.body || 'Neue Artikel verfügbar',
      icon: './icons/icon-192.png',
      badge: './icons/badge-72.png',
      tag: 'rss-update',
      data: { url: './' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});

// ── Messages from main thread ──────────────────────────────

self.addEventListener('message', event => {
  if (event.data?.type === 'STORE_CONFIG') {
    storeConfig(event.data.payload);
  }
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── IndexedDB helpers ──────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('rss-sw-config', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('config');
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeConfig(payload) {
  try {
    const db = await openDB();
    const tx = db.transaction('config', 'readwrite');
    tx.objectStore('config').put(payload, 'main');
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
  } catch {}
}

async function getStoredConfig() {
  try {
    const db = await openDB();
    const tx = db.transaction('config', 'readonly');
    return await new Promise((resolve, reject) => {
      const req = tx.objectStore('config').get('main');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

// ── RSS Parser (runs in SW context) ───────────────────────

async function proxyFetch(url) {
  for (const proxyFn of CORS_PROXIES) {
    try {
      const resp = await fetch(proxyFn(url), { signal: AbortSignal.timeout(10000) });
      if (resp.ok) return await resp.text();
    } catch {}
  }
  throw new Error('All proxies failed');
}

function parseRSS(xml, feedId, feedName) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const isAtom = !!doc.querySelector('feed');
  const items = [];

  function textOf(el, sel) {
    return el.querySelector(sel)?.textContent?.trim() || '';
  }

  if (isAtom) {
    doc.querySelectorAll('entry').forEach(entry => {
      const link = entry.querySelector('link[rel="alternate"]')?.getAttribute('href')
        || entry.querySelector('link')?.getAttribute('href')
        || entry.querySelector('link')?.textContent;
      const guid = textOf(entry, 'id') || link;
      if (!guid) return;
      items.push({ id: `${feedId}_${simpleHash(guid)}`, feedId, feedName });
    });
  } else {
    doc.querySelectorAll('item').forEach(item => {
      const guid = textOf(item, 'guid') || textOf(item, 'link');
      if (!guid) return;
      items.push({ id: `${feedId}_${simpleHash(guid)}`, feedId, feedName });
    });
  }

  return items;
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
