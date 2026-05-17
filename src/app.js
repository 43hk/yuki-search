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
   生产环境：通过 Nginx 反向代理 /suggest 转发给搜索引擎
   本地预览：/suggest 路径不存在，候选功能不可用（这是预期）
   ═══════════════════════════════════════════════ */
const SUGGEST_API = '/suggest';

/* ═══════════════════════════════════════════════
   localStorage 键名
═══════════════════════════════════════════════ */
const LS = {
  ENGINE: 'hp_engine',     // 当前搜索引擎
  BG_URL: 'hp_bg_url',     // 今日壁纸 URL
  BG_DAY: 'hp_bg_day',     // 壁纸对应日期 YYYY-MM-DD
};

/* ═══════════════════════════════════════════════
   状态
═══════════════════════════════════════════════ */
let currentEngine  = localStorage.getItem(LS.ENGINE) || 'google';
let dropdownOpen   = false;
let selectedSugIdx = -1;
let suggestTimer   = null;
let lastQuery      = '';

/* ═══════════════════════════════════════════════
   DOM 引用
═══════════════════════════════════════════════ */
const bg           = document.getElementById('bg');
const bgImg        = document.getElementById('bg-img');
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
const refreshBtn   = document.getElementById('refresh-bg');

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
   - 同一天：直接读 localStorage 缓存的 URL，秒显示
   - 新一天 / 强制刷新：拉取 API，存入缓存
   - 图片对象 onload 后才设置背景，opacity 缓入 1.8s
═══════════════════════════════════════════════ */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function applyBg(url) {
  const img  = new Image();
  img.onload = () => {
    bgImg.style.backgroundImage = `url('${url}')`;
    // 双 rAF：确保浏览器在过渡触发前已经布局好新背景
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        bgImg.classList.add('loaded');
      });
    });
    setTimeout(() => refreshBtn.classList.remove('spinning'), 700);
  };
  img.onerror = () => {
    setTimeout(() => refreshBtn.classList.remove('spinning'), 700);
  };
  img.src = url;
}

function fetchNewBg() {
  const apiUrl = `https://uapis.cn/api/v1/random/image?category=acg&type=pc&_=${Date.now()}`;

  // fetch 跟随 302 重定向，r.url 即为最终图片地址
  fetch(apiUrl, { redirect: 'follow' })
    .then(r => {
      const finalUrl = r.url || apiUrl;
      try {
        localStorage.setItem(LS.BG_URL, finalUrl);
        localStorage.setItem(LS.BG_DAY, todayStr());
      } catch (_) {
        // 存储满了也无所谓，继续显示
      }
      applyBg(finalUrl);
    })
    .catch(() => {
      // 跨域或网络失败：让 <img> 自己跟随重定向
      applyBg(apiUrl);
    });
}

function loadBg(forceRefresh = false) {
  bgImg.classList.remove('loaded');
  refreshBtn.classList.add('spinning');

  if (!forceRefresh) {
    const cachedUrl = localStorage.getItem(LS.BG_URL);
    const cachedDay = localStorage.getItem(LS.BG_DAY);
    if (cachedUrl && cachedDay === todayStr()) {
      applyBg(cachedUrl);
      return;
    }
  }

  fetchNewBg();
}

loadBg();
refreshBtn.addEventListener('click', () => loadBg(true));

/* ═══════════════════════════════════════════════
   引擎切换 — 持久化到 localStorage
═══════════════════════════════════════════════ */
function setEngine(name) {
  if (!ENGINES[name]) return;
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
   请求 /suggest?engine=google&q=xxx
   Nginx 代理转发，返回标准格式 ["query", ["s1", "s2", ...]]
═══════════════════════════════════════════════ */
async function getSuggestions(q) {
  const url = `${SUGGEST_API}?engine=${currentEngine}&q=${encodeURIComponent(q)}`;
  try {
    // 2 秒超时，避免上游慢拖累体验
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);

    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);

    if (!res.ok) return [];
    const data = await res.json();
    if (Array.isArray(data) && Array.isArray(data[1])) {
      return data[1].filter(s => typeof s === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

function clearSuggestions() {
  sugBox.innerHTML = '';
  sugBox.classList.remove('open');
  selectedSugIdx = -1;
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderSuggestions(items) {
  sugBox.innerHTML = '';
  if (!items.length) {
    sugBox.classList.remove('open');
    return;
  }

  // 最多 6 条，多余截断
  items.slice(0, 6).forEach(text => {
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
  selectedSugIdx = -1;
}

// 输入触发候选请求（防抖 200ms）
input.addEventListener('input', () => {
  const q = input.value;
  clearTimeout(suggestTimer);

  if (!q.trim()) {
    clearSuggestions();
    lastQuery = '';
    return;
  }

  lastQuery = q;
  suggestTimer = setTimeout(async () => {
    const items = await getSuggestions(q);
    // 防止旧请求覆盖新请求的结果
    if (input.value === q) renderSuggestions(items);
  }, 200);
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
