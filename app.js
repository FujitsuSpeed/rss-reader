'use strict';

// ── Constants ─────────────────────────────────────────────

const STORAGE = {
  FEEDS: 'rss_feeds',
  ARTICLES: 'rss_articles',
  SETTINGS: 'rss_settings',
};

const CORS_PROXIES = [
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

const MAX_ARTICLES = 100;

// ── Storage helpers ───────────────────────────────────────

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// ── Settings ──────────────────────────────────────────────

function getSettings() {
  return load(STORAGE.SETTINGS, {
    theme: 'auto',
    checkInterval: 3_600_000,
    notifications: false,
    showImages: true,
  });
}

function saveSettings(s) { save(STORAGE.SETTINGS, s); }

// ── Feed CRUD ─────────────────────────────────────────────

function getFeeds() { return load(STORAGE.FEEDS, []); }

function upsertFeed(feed) {
  const feeds = getFeeds();
  const idx = feeds.findIndex(f => f.id === feed.id);
  if (idx >= 0) feeds[idx] = feed; else feeds.push(feed);
  save(STORAGE.FEEDS, feeds);
}

function deleteFeed(id) {
  save(STORAGE.FEEDS, getFeeds().filter(f => f.id !== id));
  save(STORAGE.ARTICLES, getArticles().filter(a => a.feedId !== id));
}

function makeFeed(url, name) {
  return {
    id: crypto.randomUUID(),
    url: url.trim(),
    name: name?.trim() || domainOf(url),
    enabled: true,
    lastFetched: null,
    lastError: null,
  };
}

// ── Article CRUD ──────────────────────────────────────────

function getArticles() { return load(STORAGE.ARTICLES, []); }

function mergeArticles(incoming) {
  const existing = getArticles();
  const knownIds = new Set(existing.map(a => a.id));
  let added = 0;

  for (const a of incoming) {
    if (!knownIds.has(a.id)) {
      existing.unshift(a);
      added++;
    }
  }

  // Keep newest MAX_ARTICLES per feed
  const byFeed = {};
  for (const a of existing) {
    (byFeed[a.feedId] ??= []).push(a);
  }

  const trimmed = Object.values(byFeed)
    .flatMap(arr => arr.slice(0, MAX_ARTICLES))
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  save(STORAGE.ARTICLES, trimmed);
  return added;
}

function markRead(id) {
  const arts = getArticles();
  const a = arts.find(x => x.id === id);
  if (a) { a.read = true; save(STORAGE.ARTICLES, arts); }
}

function markAllRead(feedId) {
  const arts = getArticles();
  arts.forEach(a => { if (!feedId || a.feedId === feedId) a.read = true; });
  save(STORAGE.ARTICLES, arts);
}

function unreadCount(feedId) {
  return getArticles().filter(a => !a.read && (!feedId || a.feedId === feedId)).length;
}

// ── Network / CORS proxy ──────────────────────────────────

async function proxyFetch(url, timeout = 12_000) {
  // Race all proxies in parallel — first to deliver full text wins.
  // Body must be read INSIDE each attempt so we can safely abort the
  // other controllers afterwards (aborting a signal after fetch() resolves
  // but before res.text() completes would cancel the body read).
  const controllers = CORS_PROXIES.map(() => new AbortController());
  const deadline = AbortSignal.timeout(timeout);
  deadline.addEventListener('abort', () => controllers.forEach(c => c.abort()), { once: true });

  const combine = i =>
    typeof AbortSignal.any === 'function'
      ? AbortSignal.any([controllers[i].signal, deadline])
      : controllers[i].signal;

  const attempts = CORS_PROXIES.map(async (buildUrl, i) => {
    const res = await fetch(buildUrl(url), { signal: combine(i) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text(); // read body while signal is still active
  });

  try {
    const text = await Promise.any(attempts);
    controllers.forEach(c => c.abort()); // now safe to cancel in-flight losers
    return text;
  } catch (err) {
    const msgs = err instanceof AggregateError
      ? err.errors.map(e => e.message).join(' | ')
      : err.message;
    throw new Error(`Alle Proxies fehlgeschlagen: ${msgs}`);
  }
}

// ── RSS / Atom Parser ─────────────────────────────────────

function parseXML(xml, feedId, feedName) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML');

  const get = (el, sel) => el.querySelector(sel)?.textContent?.trim() ?? '';

  const isAtom = !!doc.querySelector('feed');
  const items = [];

  if (isAtom) {
    doc.querySelectorAll('entry').forEach(e => {
      const link =
        e.querySelector('link[rel="alternate"]')?.getAttribute('href') ||
        e.querySelector('link:not([rel])')?.getAttribute('href') ||
        e.querySelector('link')?.getAttribute('href') ||
        e.querySelector('link')?.textContent?.trim();
      const guid = get(e, 'id') || link;
      if (!guid) return;

      items.push({
        id: `${feedId}_${hash(guid)}`,
        feedId,
        feedName,
        title: htmlText(get(e, 'title') || 'Untitled'),
        link: link || '',
        description: get(e, 'summary') || get(e, 'content') || '',
        content: get(e, 'content') || '',
        pubDate: get(e, 'updated') || get(e, 'published') || new Date().toISOString(),
        read: false,
      });
    });
  } else {
    doc.querySelectorAll('item').forEach(item => {
      const link = item.querySelector('link')?.nextSibling?.textContent?.trim()
        || get(item, 'link');
      const guid = get(item, 'guid') || link;
      if (!guid) return;

      const contentEl =
        item.querySelector('content\\:encoded') ||
        item.querySelector('encoded');

      items.push({
        id: `${feedId}_${hash(guid)}`,
        feedId,
        feedName,
        title: htmlText(get(item, 'title') || 'Untitled'),
        link: link || '',
        description: get(item, 'description') || '',
        content: contentEl?.textContent?.trim() || '',
        pubDate: get(item, 'pubDate') || new Date().toISOString(),
        read: false,
      });
    });
  }

  return items;
}

async function fetchFeed(feed) {
  const xml = await proxyFetch(feed.url);
  return parseXML(xml, feed.id, feed.name);
}

async function fetchAllFeeds() {
  const feeds = getFeeds().filter(f => f.enabled);
  let totalAdded = 0;
  const errors = [];

  await Promise.allSettled(
    feeds.map(async feed => {
      try {
        const articles = await fetchFeed(feed);
        totalAdded += mergeArticles(articles);
        feed.lastFetched = new Date().toISOString();
        feed.lastError = null;
      } catch (e) {
        errors.push(feed.name);
        feed.lastError = e.message;
      }
      upsertFeed(feed);
    })
  );

  syncSWConfig();
  return { added: totalAdded, errors };
}

// ── Reader Mode ───────────────────────────────────────────

async function fetchReaderContent(url) {
  const { showImages } = getSettings();
  const html = await proxyFetch(url, 20_000);
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Remove noise
  [
    'script', 'style', 'noscript', 'iframe', 'nav', 'header', 'footer',
    'aside', '.ad', '.ads', '.advertisement', '.banner', '.sidebar',
    '.newsletter', '.subscribe', '.social', '.related', '.comments',
    '#comments', '[role="complementary"]', '[aria-label*="dvertis"]',
  ].forEach(sel => doc.querySelectorAll(sel).forEach(el => el.remove()));

  // Strip images early when disabled (speeds up parsing + sanitize)
  if (!showImages) {
    doc.querySelectorAll('img, picture, source, svg').forEach(el => el.remove());
    doc.querySelectorAll('figure').forEach(fig => {
      const cap = fig.querySelector('figcaption');
      fig.replaceWith(cap ?? document.createTextNode(''));
    });
  }

  // Find main content block
  const candidates = [
    'article', '[role="main"]', 'main', '.post-content', '.article-content',
    '.article-body', '.entry-content', '.post-body', '.story-body',
    '.article__body', '.content-body', '#article-body', '.prose',
  ];

  let content = null;
  for (const sel of candidates) {
    const el = doc.querySelector(sel);
    if (el?.textContent?.trim().length > 200) { content = el; break; }
  }
  content = content ?? doc.body;

  if (showImages) {
    // Fix relative image URLs and remove tracking pixels
    content.querySelectorAll('img').forEach(img => {
      if (+img.width === 1 || +img.height === 1) { img.remove(); return; }
      const src = img.getAttribute('src');
      if (src && !src.startsWith('http') && !src.startsWith('data:')) {
        try { img.setAttribute('src', new URL(src, url).href); } catch {}
      }
    });
    content.querySelectorAll('source').forEach(src => {
      const s = src.getAttribute('srcset') || src.getAttribute('src');
      if (s && !s.startsWith('http') && !s.startsWith('data:')) {
        try {
          src.setAttribute('srcset', new URL(s.split(' ')[0], url).href);
        } catch {}
      }
    });
  }

  content.querySelectorAll('[href]').forEach(el => {
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  });

  return sanitize(content.innerHTML);
}

// ── HTML sanitizer ────────────────────────────────────────

const SAFE_TAGS = new Set([
  'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
  'img', 'a', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot',
  'tr', 'th', 'td', 'caption', 'div', 'span', 'hr', 'picture', 'source',
]);

const SAFE_ATTRS = {
  a: ['href', 'title', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height', 'loading'],
  source: ['src', 'srcset', 'type', 'media'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
};

function sanitize(html) {
  const showImages = getSettings().showImages;
  const allowedTags = showImages ? SAFE_TAGS : new Set(
    [...SAFE_TAGS].filter(t => !['img', 'picture', 'source', 'figure', 'figcaption'].includes(t))
  );

  const doc = new DOMParser().parseFromString(html, 'text/html');

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) return;
    if (node.nodeType !== Node.ELEMENT_NODE) { node.remove(); return; }

    const tag = node.tagName.toLowerCase();

    // When images disabled, drop media tags entirely (keep figcaption text)
    if (!showImages && ['img', 'picture', 'source', 'svg'].includes(tag)) {
      node.remove(); return;
    }

    if (!allowedTags.has(tag)) {
      const frag = document.createDocumentFragment();
      [...node.childNodes].forEach(c => { walk(c); frag.appendChild(c); });
      node.replaceWith(frag);
      return;
    }

    const allowed = new Set([...(SAFE_ATTRS[tag] ?? []), 'class']);
    [...node.attributes].forEach(attr => {
      if (!allowed.has(attr.name)) node.removeAttribute(attr.name);
    });

    if (tag === 'a') {
      const href = node.getAttribute('href') ?? '';
      if (/^(javascript|data):/i.test(href)) node.removeAttribute('href');
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }

    if (tag === 'img') {
      const src = node.getAttribute('src') ?? '';
      if (/^javascript:/i.test(src)) node.removeAttribute('src');
      node.setAttribute('loading', 'lazy');
    }

    [...node.childNodes].forEach(walk);
  }

  [...doc.body.childNodes].forEach(walk);
  return doc.body.innerHTML;
}

// ── Notifications ─────────────────────────────────────────

async function requestNotifPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

async function sendNotification(title, body) {
  if (Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker?.ready;
  if (reg) {
    await reg.showNotification(title, {
      body,
      icon: './icons/icon-192.png',
      badge: './icons/badge-72.png',
      tag: 'rss-update',
      renotify: true,
      data: { url: './' },
    });
  } else {
    new Notification(title, { body });
  }
}

// ── SW config sync (for periodicSync in SW) ───────────────

function syncSWConfig() {
  if (!navigator.serviceWorker?.controller) return;
  const payload = {
    feeds: getFeeds(),
    knownIds: getArticles().map(a => a.id),
    settings: getSettings(),
  };
  navigator.serviceWorker.controller.postMessage({ type: 'STORE_CONFIG', payload });
}

// ── Utilities ─────────────────────────────────────────────

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function htmlText(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.textContent || d.innerText || '';
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function relTime(dateStr) {
  const date = new Date(dateStr);
  if (isNaN(date)) return '';
  const diff = Date.now() - date;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'Gerade eben';
  if (m < 60) return `vor ${m} Min.`;
  const h = Math.floor(m / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.floor(h / 24);
  if (d < 8) return `vor ${d} Tag${d > 1 ? 'en' : ''}`;
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ── UI State ──────────────────────────────────────────────

const state = {
  filter: 'all',
  selectedId: null,
  loading: false,
};

// ── Render helpers ────────────────────────────────────────

function renderSidebar() {
  const feeds = getFeeds();
  const allUnread = unreadCount();

  const feedList = document.getElementById('feed-list');
  feedList.innerHTML = [
    feedItem('all', '📰', 'Alle Artikel', allUnread),
    feedItem('unread', '🔵', 'Ungelesen', allUnread),
    feeds.length ? '<div class="divider"></div>' : '',
    ...feeds.map(f => {
      const n = unreadCount(f.id);
      const icon = f.lastError ? '⚠️' : '📡';
      return `
        <div class="feed-item ${state.filter === f.id ? 'active' : ''}" data-filter="${f.id}">
          <span class="feed-icon">${icon}</span>
          <span class="feed-name" title="${escHtml(f.url)}">${escHtml(f.name)}</span>
          ${n ? `<span class="badge">${n}</span>` : ''}
          <button class="feed-delete-btn" data-id="${f.id}" title="Feed löschen" aria-label="Feed löschen">×</button>
        </div>
        ${f.lastError ? `<div class="feed-error-hint" title="${escHtml(f.lastError)}">⚠ ${escHtml(f.lastError.slice(0, 40))}</div>` : ''}
      `;
    }),
  ].join('');

  feedList.querySelectorAll('.feed-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.feed-delete-btn')) return;
      setFilter(el.dataset.filter);
    });
  });

  feedList.querySelectorAll('.feed-delete-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const feed = getFeeds().find(f => f.id === btn.dataset.id);
      if (!feed) return;
      if (!confirm(`Feed "${feed.name}" löschen?\n\nAlle gespeicherten Artikel dieses Feeds werden ebenfalls gelöscht.`)) return;
      deleteFeed(btn.dataset.id);
      if (state.filter === btn.dataset.id) setFilter('all', false);
      renderAll();
    });
  });
}

function feedItem(filter, icon, label, count) {
  return `
    <div class="feed-item ${state.filter === filter ? 'active' : ''}" data-filter="${filter}">
      <span class="feed-icon">${icon}</span>
      <span class="feed-name">${label}</span>
      ${count ? `<span class="badge">${count}</span>` : ''}
    </div>
  `;
}

function renderList() {
  let arts = getArticles();

  if (state.filter === 'unread') arts = arts.filter(a => !a.read);
  else if (state.filter !== 'all') arts = arts.filter(a => a.feedId === state.filter);

  const feed = getFeeds().find(f => f.id === state.filter);
  const titles = { all: 'Alle Artikel', unread: 'Ungelesen' };
  document.getElementById('list-title').textContent = titles[state.filter] ?? feed?.name ?? '';
  document.getElementById('list-count').textContent = arts.length ? `${arts.length} Artikel` : '';

  const container = document.getElementById('articles-container');

  if (!arts.length) {
    const isFeeds = getFeeds().length > 0;
    container.innerHTML = `
      <div class="empty-state">
        ${rssIconSVG(64)}
        <p>${isFeeds ? 'Keine Artikel vorhanden' : 'Noch keine Feeds hinzugefügt'}</p>
        <p>${isFeeds ? 'Klicke auf Aktualisieren um neue Artikel zu laden' : 'Klicke auf + um deinen ersten RSS-Feed hinzuzufügen'}</p>
        ${!isFeeds ? '<button class="btn btn-primary" data-action="add-feed">Feed hinzufügen</button>' : ''}
      </div>
    `;
    container.querySelector('[data-action="add-feed"]')?.addEventListener('click', showAddModal);
    return;
  }

  container.innerHTML = arts.map(a => `
    <div class="article-item ${a.read ? '' : 'unread'} ${state.selectedId === a.id ? 'selected' : ''}"
         data-id="${a.id}" role="button" tabindex="0" aria-label="${escHtml(a.title)}">
      <div class="article-item-inner">
        <div class="article-item-title">${escHtml(a.title)}</div>
        <div class="article-item-meta">
          <span class="article-feed">${escHtml(a.feedName)}</span>
          <span class="article-date">${relTime(a.pubDate)}</span>
        </div>
      </div>
      ${!a.read ? '<div class="unread-dot" aria-hidden="true"></div>' : ''}
    </div>
  `).join('');

  container.querySelectorAll('.article-item').forEach(el => {
    el.addEventListener('click', () => openArticle(el.dataset.id));
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') openArticle(el.dataset.id); });
  });
}

function renderAll() {
  renderSidebar();
  renderList();
}

// ── Article reader ────────────────────────────────────────

function openArticle(id) {
  const arts = getArticles();
  const article = arts.find(a => a.id === id);
  if (!article) return;

  state.selectedId = id;
  markRead(id);

  // Update list item in-place without full re-render
  document.querySelectorAll('.article-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === id);
    if (el.dataset.id === id) {
      el.classList.remove('unread');
      el.querySelector('.unread-dot')?.remove();
    }
  });

  renderSidebar();
  renderReader(article);

  // Mobile: slide in reader
  if (window.innerWidth < 1024) {
    document.getElementById('reader-panel').classList.add('visible');
    document.body.style.overflow = 'hidden';
  }
}

function renderReader(article) {
  const panel = document.getElementById('reader-panel');
  const scroll = document.getElementById('reader-scroll-area');

  const body = article.content || article.description || '';

  scroll.innerHTML = `
    <div class="reader-article-header">
      <h1>${escHtml(article.title)}</h1>
      <div class="reader-meta">
        <span class="reader-feed">${escHtml(article.feedName)}</span>
        <time datetime="${escHtml(article.pubDate)}">${relTime(article.pubDate)}</time>
      </div>
      <div class="reader-toolbar">
        ${article.link ? `
          <button class="btn btn-secondary" id="btn-reader-mode">📖 Vollständigen Artikel laden</button>
          <a href="${escHtml(article.link)}" target="_blank" rel="noopener noreferrer" class="btn btn-outline">🔗 Im Browser öffnen</a>
        ` : ''}
      </div>
    </div>
    <div class="reader-body" id="reader-body">
      ${body.trim() ? sanitize(body) : '<p class="no-content">Klicke auf "Vollständigen Artikel laden" um den Artikel zu lesen, oder öffne ihn direkt im Browser.</p>'}
    </div>
    <div class="reader-loading" id="reader-loading" style="display:none">
      <div class="spinner"></div>
      <p>Artikel wird geladen…</p>
    </div>
  `;

  scroll.scrollTop = 0;
  panel.classList.add('has-article');

  document.getElementById('btn-reader-mode')?.addEventListener('click', () => loadReader(article));
}

async function loadReader(article) {
  const body = document.getElementById('reader-body');
  const loading = document.getElementById('reader-loading');
  const btn = document.getElementById('btn-reader-mode');

  body.style.opacity = '.3';
  loading.style.display = 'flex';
  if (btn) btn.disabled = true;

  try {
    const html = await fetchReaderContent(article.link);
    body.innerHTML = html;
    body.style.opacity = '1';
    if (btn) { btn.textContent = '✓ Vollständiger Artikel'; btn.disabled = true; }
  } catch {
    body.style.opacity = '1';
    body.insertAdjacentHTML('beforeend', `
      <p class="error-msg">
        Artikel konnte nicht geladen werden.
        <a href="${escHtml(article.link)}" target="_blank" rel="noopener noreferrer">Im Browser öffnen →</a>
      </p>
    `);
    if (btn) { btn.textContent = '📖 Vollständigen Artikel laden'; btn.disabled = false; }
  } finally {
    loading.style.display = 'none';
  }
}

function closeReader() {
  state.selectedId = null;
  document.getElementById('reader-panel').classList.remove('visible', 'has-article');
  document.body.style.overflow = '';
  document.getElementById('reader-scroll-area').innerHTML = `
    <div class="reader-placeholder">
      ${rssIconSVG(72)}
      <p>Wähle einen Artikel aus der Liste</p>
    </div>
  `;
  document.querySelectorAll('.article-item.selected').forEach(el => el.classList.remove('selected'));
}

// ── Sidebar / modal helpers ───────────────────────────────

function setFilter(filter, rerender = true) {
  state.filter = filter;
  state.selectedId = null;
  closeReader();
  if (rerender) renderAll();
  if (window.innerWidth < 1024) closeSidebar();
}

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.add('visible');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('visible');
}

function showAddModal() {
  document.getElementById('add-feed-modal').classList.add('visible');
  setTimeout(() => document.getElementById('feed-url').focus(), 50);
}

function hideAddModal() {
  document.getElementById('add-feed-modal').classList.remove('visible');
  document.getElementById('feed-url').value = '';
  document.getElementById('feed-name').value = '';
  document.getElementById('add-feed-error').textContent = '';
}

function showSettingsModal() {
  const s = getSettings();
  document.getElementById('setting-theme').value = s.theme;
  document.getElementById('setting-interval').value = s.checkInterval;
  document.getElementById('setting-notifications').checked = s.notifications;
  document.getElementById('setting-images').checked = s.showImages ?? true;
  document.getElementById('settings-modal').classList.add('visible');
}

function hideSettingsModal() {
  document.getElementById('settings-modal').classList.remove('visible');
}

// ── Refresh ───────────────────────────────────────────────

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  const btn = document.getElementById('btn-refresh');
  btn.classList.add('loading');
  btn.disabled = true;

  try {
    const { added, errors } = await fetchAllFeeds();
    renderAll();

    const s = getSettings();
    if (added > 0 && s.notifications && Notification.permission === 'granted') {
      await sendNotification('RSS Reader', `${added} neue Artikel verfügbar`);
    }

    if (errors.length) {
      console.warn('Feed errors:', errors);
    }
  } finally {
    state.loading = false;
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

// ── Add feed ──────────────────────────────────────────────

async function addFeed() {
  const urlInput = document.getElementById('feed-url');
  const nameInput = document.getElementById('feed-name');
  const errEl = document.getElementById('add-feed-error');
  const btn = document.getElementById('btn-save-feed');

  const url = urlInput.value.trim();
  if (!url) { urlInput.focus(); return; }

  // Basic URL validation
  try { new URL(url); } catch {
    errEl.textContent = 'Bitte eine gültige URL eingeben.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Wird geladen…';
  errEl.textContent = '';

  const feed = makeFeed(url, nameInput.value);
  try {
    const articles = await fetchFeed(feed);
    feed.lastFetched = new Date().toISOString();
    upsertFeed(feed);
    mergeArticles(articles);
    syncSWConfig();
    hideAddModal();
    renderAll();
  } catch (e) {
    errEl.textContent = `Feed konnte nicht geladen werden: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Feed hinzufügen';
  }
}

// ── Settings save ─────────────────────────────────────────

async function applySettings() {
  const theme = document.getElementById('setting-theme').value;
  const interval = +document.getElementById('setting-interval').value;
  const notif = document.getElementById('setting-notifications').checked;

  if (notif && !(await requestNotifPermission())) {
    document.getElementById('setting-notifications').checked = false;
    document.getElementById('notif-error').textContent =
      'Benachrichtigungen wurden nicht erlaubt. Bitte Browsereinstellungen prüfen.';
    return;
  }

  const showImages = document.getElementById('setting-images').checked;

  document.getElementById('notif-error').textContent = '';
  saveSettings({ theme, checkInterval: interval, notifications: notif, showImages });
  document.documentElement.setAttribute('data-theme', theme);
  hideSettingsModal();
  syncSWConfig();

  // Update periodicSync registration
  if ('serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.ready;
    if ('periodicSync' in reg) {
      if (notif) {
        try { await reg.periodicSync.register('rss-check', { minInterval: interval }); } catch {}
      } else {
        try { await reg.periodicSync.unregister('rss-check'); } catch {}
      }
    }
  }
}

// ── Event wiring ──────────────────────────────────────────

function bindEvents() {
  // Sidebar
  document.getElementById('btn-sidebar-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.contains('open') ? closeSidebar() : openSidebar();
  });
  document.getElementById('sidebar-overlay').addEventListener('click', closeSidebar);

  // Add feed
  document.querySelectorAll('[data-action="add-feed"]').forEach(el =>
    el.addEventListener('click', showAddModal));
  document.getElementById('btn-close-modal').addEventListener('click', hideAddModal);
  document.getElementById('btn-cancel-feed').addEventListener('click', hideAddModal);
  document.getElementById('btn-save-feed').addEventListener('click', addFeed);
  document.getElementById('feed-url').addEventListener('keydown', e => { if (e.key === 'Enter') addFeed(); });
  document.getElementById('add-feed-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) hideAddModal();
  });

  // Refresh
  document.getElementById('btn-refresh').addEventListener('click', refresh);

  // Reader back
  document.getElementById('btn-reader-back').addEventListener('click', closeReader);

  // Mark all read
  document.getElementById('btn-mark-all-read').addEventListener('click', () => {
    markAllRead(state.filter === 'all' || state.filter === 'unread' ? null : state.filter);
    renderAll();
  });

  // Settings
  document.getElementById('btn-settings').addEventListener('click', showSettingsModal);
  document.getElementById('btn-close-settings').addEventListener('click', hideSettingsModal);
  document.getElementById('btn-close-settings-footer').addEventListener('click', hideSettingsModal);
  document.getElementById('settings-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) hideSettingsModal();
  });
  document.getElementById('btn-save-settings').addEventListener('click', applySettings);

  // Beispiel-Feeds
  document.querySelectorAll('[data-example]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('feed-url').value = btn.dataset.example;
      document.getElementById('feed-name').value = btn.textContent.trim();
    });
  });

  document.getElementById('setting-notifications').addEventListener('change', async e => {
    if (!e.target.checked) return;
    const ok = await requestNotifPermission();
    if (!ok) {
      e.target.checked = false;
      document.getElementById('notif-error').textContent =
        'Benachrichtigungen wurden nicht erlaubt. Bitte Browsereinstellungen prüfen.';
    }
  });

  // Clear articles
  document.getElementById('btn-clear-articles').addEventListener('click', () => {
    if (!confirm('Alle gespeicherten Artikel löschen?\n\nDie Feeds bleiben erhalten.')) return;
    save(STORAGE.ARTICLES, []);
    closeReader();
    renderAll();
  });

  // PWA Install
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installPrompt = e;
    document.getElementById('btn-install').style.display = 'flex';
  });
  document.getElementById('btn-install').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') document.getElementById('btn-install').style.display = 'none';
    installPrompt = null;
  });
  window.addEventListener('appinstalled', () => {
    document.getElementById('btn-install').style.display = 'none';
  });

  // SW messages
  navigator.serviceWorker?.addEventListener('message', e => {
    if (e.data?.type === 'NEW_ARTICLES') {
      renderAll();
    }
  });

  // Keyboard
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.getElementById('add-feed-modal').classList.contains('visible')) { hideAddModal(); return; }
      if (document.getElementById('settings-modal').classList.contains('visible')) { hideSettingsModal(); return; }
      if (window.innerWidth < 1024 && document.getElementById('reader-panel').classList.contains('visible')) { closeReader(); return; }
    }
  });
}

// ── SVG assets ────────────────────────────────────────────

function rssIconSVG(size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>
  </svg>`;
}

// ── SW Registration ───────────────────────────────────────

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    // Auto-reload when a new SW takes control of this page.
    // hadController guards against reloading on the very first install
    // (no previous controller = no update, page already has fresh content).
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloading) {
        reloading = true;
        window.location.reload();
      }
    });

    // updateViaCache:'none' → browser always re-fetches sw.js from the network,
    // never from the HTTP cache, so GitHub Pages' Cache-Control can't hide updates.
    const reg = await navigator.serviceWorker.register('./sw.js', {
      scope: './',
      updateViaCache: 'none',
    });

    // Trigger a SW update check whenever the app is foregrounded.
    // Without this, PWAs that are "resumed" (BFCache / app-switch on mobile)
    // never get a navigation event, so the browser never checks for a new SW.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });

    const s = getSettings();
    if (s.notifications && 'periodicSync' in reg) {
      const status = await navigator.permissions.query({ name: 'periodic-background-sync' }).catch(() => null);
      if (status?.state === 'granted') {
        await reg.periodicSync.register('rss-check', { minInterval: s.checkInterval }).catch(() => {});
      }
    }
  } catch (e) {
    console.warn('SW registration failed:', e);
  }
}

// ── Init ──────────────────────────────────────────────────

async function init() {
  // Apply theme immediately to avoid flash
  document.documentElement.setAttribute('data-theme', getSettings().theme);

  await registerSW();
  bindEvents();
  renderAll();

  // Auto-refresh on start if feeds exist
  if (getFeeds().length > 0) refresh();

  // Periodic check while page is open
  const s = getSettings();
  setInterval(async () => {
    const { added } = await fetchAllFeeds();
    renderAll();
    const cur = getSettings();
    if (added > 0 && cur.notifications && Notification.permission === 'granted') {
      await sendNotification('RSS Reader', `${added} neue Artikel verfügbar`);
    }
  }, s.checkInterval);
}

document.addEventListener('DOMContentLoaded', init);
