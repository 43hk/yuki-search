/* ═══════════════════════════════════════════════
   搜索引擎配置（仅 Google 和 Bing）
═══════════════════════════════════════════════ */
const ENGINES = {
  google: {
    label: 'Google',
    url:   q => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  },
  bing: {
    label: 'Bing',
    url:   q => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  },
};

/* 候选接口
   ─────────────────────────────────────────────
   直接请求搜索引擎候选接口；失败时返回空候选，不走自有服务器。
   ═══════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════
   localStorage 键名
═══════════════════════════════════════════════ */
const LS = {
  ENGINE: 'hp_engine',     // 当前搜索引擎
  BG_URL: 'hp_bg_url',     // 当前壁纸 URL，用于上一张回退
  BG_NEXT: 'hp_bg_next',   // 下次打开优先显示的预缓存壁纸 URL
  BG_TYPE: 'hp_bg_type',   // 壁纸设备类型 pc / mb
};

const BG_CACHE_NAME = 'hp-wallpaper-cache-v1';
const MAX_SUGGESTIONS = 6;
const SUGGEST_DIRECT_TIMEOUT = 650;
const SUGGEST_DEBOUNCE = 50;

/* ═══════════════════════════════════════════════
   状态
═══════════════════════════════════════════════ */
let currentEngine  = localStorage.getItem(LS.ENGINE) || 'google';
let dropdownOpen   = false;
let selectedSugIdx = -1;
let suggestTimer   = null;
let lastQuery      = '';
let activeBgLayer  = null;
let activeBgUrl    = '';
let previousBgUrl  = '';
let bgTransitioning = false;
let suggestRequestSeq = 0;
const suggestCache = new Map();

/* ═══════════════════════════════════════════════
   DOM 引用
═══════════════════════════════════════════════ */
const bg           = document.getElementById('bg');
const bgImg        = document.getElementById('bg-img');
const bgNext       = document.getElementById('bg-next');
const overlay      = document.getElementById('overlay');
const clockEl      = document.getElementById('clock');
const dateEl       = document.getElementById('date-label');
const stage        = document.getElementById('stage');
const input        = document.getElementById('search-input');
const searchBox    = document.getElementById('search-box');
const engineToggle = document.getElementById('engine-toggle');
const engineLabel  = document.getElementById('engine-label');
const dropdown     = document.getElementById('engine-dropdown');
const ddItems      = document.querySelectorAll('.dd-item');
const sugBox       = document.getElementById('suggestions');
const prevBgBtn    = document.getElementById('prev-bg');
const downloadBtn  = document.getElementById('download-bg');

/* ═══════════════════════════════════════════════
   时钟
═══════════════════════════════════════════════ */
function updateClock() {
  const now    = new Date();
  const hh     = String(now.getHours()).padStart(2, '0');
  const mm     = String(now.getMinutes()).padStart(2, '0');
  const days   = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  clockEl.textContent = `${hh}:${mm}`;
  dateEl.textContent  = `${days[now.getDay()]}  ·  ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
}

updateClock();
setInterval(updateClock, 1000);

/* ═══════════════════════════════════════════════
   壁纸管理
   ─────────────────────────────────────────────
   - 打开页面优先显示上次预缓存壁纸；没有缓存时拉取第一张
   - 每次显示后后台预缓存下一张，保持静态页面直连第三方图片接口
   - 图片对象 onload 后才设置背景，opacity 缓入 1.8s
═══════════════════════════════════════════════ */
function getWallpaperType() {
  const coarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const narrowScreen = window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
  return coarsePointer || narrowScreen ? 'mb' : 'pc';
}

function wallpaperApiUrl(type) {
  const params = new URLSearchParams({
    category: 'acg',
    type,
  });
  params.set('_', Date.now());
  return `https://uapis.cn/api/v1/random/image?${params.toString()}`;
}

function isStableWallpaperUrl(url) {
  return !!url && !url.includes('/api/v1/random/image');
}

function cacheImage(url) {
  if (!('caches' in window) || !url) return Promise.resolve();

  const req = new Request(url, {
    mode: 'no-cors',
    cache: 'force-cache',
  });

  return caches.open(BG_CACHE_NAME)
    .then(cache => cache.match(req)
      .then(hit => hit || fetch(req).then(res => cache.put(req, res.clone()))))
    .catch(() => {});
}

function pruneWallpaperCache() {
  if (!('caches' in window)) return;

  const keepUrls = new Set(
    [localStorage.getItem(LS.BG_URL), localStorage.getItem(LS.BG_NEXT)]
      .filter(isStableWallpaperUrl)
  );

  caches.open(BG_CACHE_NAME)
    .then(cache => cache.keys()
      .then(requests => {
        requests.forEach(req => {
          if (!keepUrls.has(req.url)) cache.delete(req);
        });
      }))
    .catch(() => {});
}

function preloadWallpaperImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(url);
    img.onerror = reject;
    img.decoding = 'async';
    img.src = url;
  });
}

function updateWallpaperControls() {
  if (prevBgBtn) prevBgBtn.disabled = !isStableWallpaperUrl(previousBgUrl);
  if (downloadBtn) downloadBtn.disabled = !isStableWallpaperUrl(activeBgUrl);
}

function removeLegacyWallpaperStorage() {
  localStorage.removeItem('hp_bg_prev');
  localStorage.removeItem('hp_bg_queue');
  localStorage.removeItem('hp_bg_index');
}

function applyCachedBg(url) {
  bgImg.style.backgroundImage = `url('${url}')`;
  bgImg.classList.add('loaded');
  bgNext.classList.remove('loaded');
  bgNext.style.backgroundImage = '';
  activeBgLayer = bgImg;
  activeBgUrl = url;
  updateWallpaperControls();
  cacheImage(url);
}

function applyBg(url, { rememberPrevious = true, onDone = null } = {}) {
  const img  = new Image();
  img.onload = async () => {
    try {
      if (img.decode) await img.decode();
    } catch (_) {
      // decode 失败不阻断显示，onload 已经说明图片可用。
    }

    const oldLayer = activeBgLayer || bgImg;
    const nextLayer = oldLayer === bgImg ? bgNext : bgImg;

    nextLayer.classList.remove('loaded');
    nextLayer.style.backgroundImage = `url('${url}')`;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        nextLayer.classList.add('loaded');
      });
    });

    setTimeout(() => {
      oldLayer.classList.remove('loaded');
      oldLayer.style.backgroundImage = '';
      activeBgLayer = nextLayer;
      if (rememberPrevious && isStableWallpaperUrl(activeBgUrl) && activeBgUrl !== url) {
        previousBgUrl = activeBgUrl;
      }
      activeBgUrl = url;
      saveBgCache(url, getWallpaperType());
      updateWallpaperControls();
      if (onDone) onDone();
    }, 1900);
  };
  img.onerror = () => {
    bgTransitioning = false;
    updateWallpaperControls();
  };
  img.decoding = 'async';
  img.src = url;
  cacheImage(url);
}

function resolveWallpaperUrl(type) {
  const apiUrl = wallpaperApiUrl(type);

  return fetch(apiUrl, { redirect: 'follow' })
    .then(r => {
      const finalUrl = r.url || apiUrl;
      return isStableWallpaperUrl(finalUrl) ? finalUrl : apiUrl;
    })
    .catch(() => apiUrl);
}

async function preloadNextBg(type) {
  try {
    const url = await resolveWallpaperUrl(type);
    if (!isStableWallpaperUrl(url)) return;
    await preloadWallpaperImage(url);
    localStorage.setItem(LS.BG_NEXT, url);
    localStorage.setItem(LS.BG_TYPE, type);
    cacheImage(url);
    pruneWallpaperCache();
  } catch (_) {
    // 预缓存失败不影响当前壁纸显示。
  }
}

async function fetchAndShowFirstBg(type) {
  const url = await resolveWallpaperUrl(type);
  applyBg(url, { rememberPrevious: false });
  if (isStableWallpaperUrl(url)) saveBgCache(url, type);
  preloadNextBg(type);
}

function saveBgCache(url, type) {
  if (!isStableWallpaperUrl(url)) return;

  try {
    localStorage.setItem(LS.BG_URL, url);
    localStorage.setItem(LS.BG_TYPE, type);
    pruneWallpaperCache();
  } catch (_) {
    // 存储满了也无所谓，继续显示
  }
}

function loadBg() {
  const type = getWallpaperType();
  const cachedNextUrl = localStorage.getItem(LS.BG_NEXT);
  const cachedCurrentUrl = localStorage.getItem(LS.BG_URL);
  const cachedType = localStorage.getItem(LS.BG_TYPE);
  const canUseCachedNext = isStableWallpaperUrl(cachedNextUrl) && cachedType === type;

  removeLegacyWallpaperStorage();

  previousBgUrl = cachedType === type && isStableWallpaperUrl(cachedCurrentUrl) && cachedCurrentUrl !== cachedNextUrl
    ? cachedCurrentUrl
    : '';

  if (!canUseCachedNext) {
    if (cachedNextUrl) localStorage.removeItem(LS.BG_NEXT);
    fetchAndShowFirstBg(type);
    updateWallpaperControls();
    return;
  }

  applyCachedBg(cachedNextUrl);
  saveBgCache(cachedNextUrl, type);
  preloadNextBg(type);
}

function downloadCurrentBg() {
  if (!isStableWallpaperUrl(activeBgUrl)) return;

  const a = document.createElement('a');
  a.href = activeBgUrl;
  a.download = `yuki-wallpaper-${Date.now()}.jpg`;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function showPreviousBg() {
  if (bgTransitioning || !isStableWallpaperUrl(previousBgUrl)) return;

  const targetUrl = previousBgUrl;
  previousBgUrl = '';
  bgTransitioning = true;
  updateWallpaperControls();
  applyBg(targetUrl, {
    rememberPrevious: false,
    onDone: () => {
      bgTransitioning = false;
      updateWallpaperControls();
    },
  });
}

loadBg();
prevBgBtn.addEventListener('click', showPreviousBg);
downloadBtn.addEventListener('click', downloadCurrentBg);
updateWallpaperControls();

/* ═══════════════════════════════════════════════
   引擎切换 — 持久化到 localStorage
═══════════════════════════════════════════════ */
function setEngine(name) {
  if (!ENGINES[name]) return;
  suggestRequestSeq += 1;
  currentEngine = name;
  localStorage.setItem(LS.ENGINE, name);
  engineLabel.textContent = ENGINES[name].label;
  ddItems.forEach(el => el.classList.toggle('active', el.dataset.engine === name));
  clearSuggestions();
}

// 页面加载时恢复上次选择
setEngine(currentEngine);

/* ═══════════════════════════════════════════════
   波纹动画
═══════════════════════════════════════════════ */
function spawnRipple(el, e) {
  const rect = el.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 1.6;
  const r    = document.createElement('span');
  r.className     = 'ripple';
  r.style.cssText = `
    width:${size}px;
    height:${size}px;
    left:${e.clientX - rect.left - size / 2}px;
    top:${e.clientY - rect.top  - size / 2}px;
  `;
  el.appendChild(r);
  r.addEventListener('animationend', () => r.remove());
}

/* ═══════════════════════════════════════════════
   引擎下拉菜单
═══════════════════════════════════════════════ */
function openDropdown() {
  dropdownOpen = true;
  dropdown.classList.add('open');
  engineToggle.classList.add('open');
}

function closeDropdown() {
  dropdownOpen = false;
  dropdown.classList.remove('open');
  engineToggle.classList.remove('open');
}

engineToggle.addEventListener('click', e => {
  e.stopPropagation();
  spawnRipple(engineToggle, e);
  dropdownOpen ? closeDropdown() : openDropdown();
});

ddItems.forEach(item => {
  item.addEventListener('click', e => {
    spawnRipple(item, e);
    setEngine(item.dataset.engine);
    setTimeout(closeDropdown, 180);   // 等波纹动画播完再关闭
  });
});

// 点击外部关闭下拉
document.addEventListener('click', e => {
  if (!dropdown.contains(e.target) && e.target !== engineToggle) {
    closeDropdown();
  }
});

/* ═══════════════════════════════════════════════
   搜索候选
   ─────────────────────────────────────────────
   直接请求 Google / Bing 候选接口，返回标准格式 ["query", ["s1", "s2", ...]]
═══════════════════════════════════════════════ */
async function getSuggestions(q) {
  const cacheKey = `${currentEngine}:${q.trim().toLowerCase()}`;
  if (suggestCache.has(cacheKey)) return suggestCache.get(cacheKey);

  const items = await getDirectSuggestions(q);
  return rememberSuggestions(cacheKey, items);
}

function rememberSuggestions(key, items) {
  const uniqueItems = [...new Set(items)].slice(0, MAX_SUGGESTIONS);
  suggestCache.set(key, uniqueItems);

  if (suggestCache.size > 60) {
    suggestCache.delete(suggestCache.keys().next().value);
  }

  return uniqueItems;
}

function normalizeSuggestions(data) {
  if (Array.isArray(data) && Array.isArray(data[1])) {
    return data[1].filter(s => typeof s === 'string');
  }
  if (data && Array.isArray(data.AS && data.AS.Results)) {
    return data.AS.Results
      .flatMap(group => Array.isArray(group.Suggests) ? group.Suggests : [])
      .map(item => item.Txt)
      .filter(s => typeof s === 'string');
  }
  return [];
}

async function getDirectSuggestions(q) {
  const encoded = encodeURIComponent(q);
  const endpoints = {
    google: [
      `https://suggestqueries.google.com/complete/search?client=chrome&q=${encoded}`,
      `https://suggestqueries.google.com/complete/search?client=firefox&q=${encoded}`,
    ],
    bing: [
      `https://api.bing.com/osjson.aspx?query=${encoded}`,
      `https://api.bing.com/qsonhs.aspx?type=cb&q=${encoded}`,
    ],
  };

  return firstSuggestionResult(endpoints[currentEngine] || []);
}

function firstSuggestionResult(endpoints) {
  if (!endpoints.length) return Promise.resolve([]);

  return new Promise(resolve => {
    let pending = endpoints.length;
    let settled = false;

    endpoints.forEach(async url => {
      try {
        const data = await getSuggestionEndpoint(url);
        const items = normalizeSuggestions(data);
        if (!settled && items.length) {
          settled = true;
          resolve(items);
        }
      } catch (_) {
        // 等其它并发候选接口。
      } finally {
        pending -= 1;
        if (!settled && pending === 0) {
          settled = true;
          resolve([]);
        }
      }
    });
  });
}

async function getSuggestionEndpoint(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SUGGEST_DIRECT_TIMEOUT);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) return res.json();
  } catch (_) {
    // CORS、权限或超时都直接放弃该并发分支。
  }

  return [];
}

function clearSuggestions() {
  sugBox.innerHTML = '';
  sugBox.classList.remove('open');
  searchBox.classList.remove('suggestions-open');
  selectedSugIdx = -1;
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderSuggestions(items) {
  sugBox.innerHTML = '';
  if (!items.length) {
    sugBox.classList.remove('open');
    searchBox.classList.remove('suggestions-open');
    return;
  }

  // 固定最多 6 条，多余截断，不出现滚动条。
  items.slice(0, MAX_SUGGESTIONS).forEach(text => {
    const btn = document.createElement('button');
    btn.className = 'sug-item';
    btn.innerHTML = `
      <svg class="sug-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <span>${escHtml(text)}</span>
    `;
    // 用 mousedown 而非 click，避免 input blur 提前关闭候选
    btn.addEventListener('mousedown', e => {
      e.preventDefault();
      input.value = text;
      clearSuggestions();
      doSearch();
    });
    sugBox.appendChild(btn);
  });

  sugBox.classList.add('open');
  searchBox.classList.add('suggestions-open');
  selectedSugIdx = -1;
}

// 输入触发候选请求（轻量防抖，接口并发取最快结果）
input.addEventListener('input', () => {
  const q = input.value;
  clearTimeout(suggestTimer);

  if (!q.trim()) {
    clearSuggestions();
    lastQuery = '';
    return;
  }

  lastQuery = q;
  const requestSeq = ++suggestRequestSeq;

  const cachedItems = suggestCache.get(`${currentEngine}:${q.trim().toLowerCase()}`);
  if (cachedItems) {
    renderSuggestions(cachedItems);
    return;
  }

  suggestTimer = setTimeout(async () => {
    const items = await getSuggestions(q);
    // 防止旧请求覆盖新请求的结果
    if (requestSeq === suggestRequestSeq && input.value === q) renderSuggestions(items);
  }, SUGGEST_DEBOUNCE);
});

// 键盘导航候选
input.addEventListener('keydown', e => {
  const items = [...sugBox.querySelectorAll('.sug-item')];

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedSugIdx = Math.min(selectedSugIdx + 1, items.length - 1);
    items.forEach((el, i) => el.classList.toggle('selected', i === selectedSugIdx));
    if (items[selectedSugIdx]) {
      input.value = items[selectedSugIdx].querySelector('span').textContent;
    }
    return;
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedSugIdx = Math.max(selectedSugIdx - 1, -1);
    items.forEach((el, i) => el.classList.toggle('selected', i === selectedSugIdx));
    input.value = selectedSugIdx === -1
      ? lastQuery
      : items[selectedSugIdx].querySelector('span').textContent;
    return;
  }

  if (e.key === 'Enter') {
    doSearch();
    return;
  }

  if (e.key === 'Escape') {
    if (sugBox.classList.contains('open')) {
      clearSuggestions();
      return;
    }
  }
});

/* ═══════════════════════════════════════════════
   执行搜索
═══════════════════════════════════════════════ */
function doSearch() {
  const q = input.value.trim();
  if (!q) return;
  clearSuggestions();
  window.open(ENGINES[currentEngine].url(q), '_blank');
}

/* ═══════════════════════════════════════════════
   聚焦 / 失焦状态
═══════════════════════════════════════════════ */
function enterFocus() {
  closeDropdown();
  searchBox.classList.add('focused');
  bg.classList.add('blurred');
  overlay.classList.add('active');
  clockEl.classList.add('hidden');
  dateEl.classList.add('hidden');
}

function exitFocus() {
  if (document.activeElement === input) return;
  searchBox.classList.remove('focused');
  bg.classList.remove('blurred');
  overlay.classList.remove('active');
  clockEl.classList.remove('hidden');
  dateEl.classList.remove('hidden');
  clearSuggestions();
}

input.addEventListener('focus', enterFocus);
input.addEventListener('blur', () => setTimeout(exitFocus, 180));

// 全局 ESC：依次关闭下拉、候选、退出聚焦
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (dropdownOpen)                      { closeDropdown();    return; }
  if (sugBox.classList.contains('open')) { clearSuggestions(); return; }
  input.blur();
  exitFocus();
});

// 点击舞台空白处退出聚焦
stage.addEventListener('click', e => {
  if (e.target === stage) {
    input.blur();
    exitFocus();
  }
});
