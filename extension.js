(() => {
  "use strict";

  // ─────────────────────────────────────────────
  // 보낸 이미지 관리 v1.0.0
  //
  // v1.0.0: 2단계 — 선택한 사진 삭제(메시지·숨은 답변 버전의 같은 사진까지, 메시지 자체는 유지)와
  //         WebP 축소(품질·긴 변 상한, 표본 예상치, 결과가 더 크면 유지). 적용 직전 서버에서 다시 읽어 바뀐 사진은 건너뛰고,
  //         적용 뒤 다시 읽어 확인. 열린 방이 생성 중이면 대기·미룸, 다른 탭·기기 잠금(확장 저장소), 요청 제한 대응.
  //         창 끌어 옮기기·크기 조절·기억, 좁은 창에서 도구 줄 자동 축약.
  // v0.1.0: 1단계 — 모아보기(방별·날짜별 그리드, 큰 보기, 메시지로 이동, 다운로드, 다중 선택).
  //
  // 채팅 중 캐릭터에게 보낸 이미지는 파일이 아니라 메시지의 extra.attachments 안에
  // base64(data: URL)로 통째로 들어 있다. 엔진에는 이것을 모아 보는 화면이 없다.
  // 이 확장은 메시지를 엔진 화면과 같은 페이지 단위(50개, ?limit=&before=커서)로 읽어
  // 사진만 골라 썸네일로 보여 준다. 원본 base64는 메모리에 두지 않고(221장이면 70MB)
  // 큰 보기·다운로드처럼 필요할 때만 그 메시지 한 개를 다시 받는다.
  //
  // 들어가는 자리: 화면 오른쪽 가장자리의 둥근 버튼(끌어서 옮길 수 있음) → 창
  // 창 구성: 위쪽 고정 도구 줄(위치·열 수·정렬·선택·읽기·닫기) + 상태 줄, 아래 스크롤 그리드
  // ─────────────────────────────────────────────

  if (typeof marinara === "undefined" || !marinara || !marinara.storage) {
    console.warn("[보낸 이미지 관리] marinara 런타임이 없어 실행하지 않습니다.");
    return;
  }

  const EXT_NAME = "보낸 이미지 관리";
  const ACTIVE_CHAT_KEY = "marinara-active-chat-id";
  const FAB_POS_KEY = "sim-fab-pos";
  const WIN_RECT_KEY = "sim-win-rect"; // PC에서 창 위치·크기 기억
  const WIN_MIN_W = 360;
  const WIN_MIN_H = 260;
  // 메시지 한 페이지 크기. 1,520개짜리 방 실측에서 50개면 응답이 2~4MB라 화면이 멈추지 않는다.
  const PAGE_SIZE = 50;
  // 썸네일 긴 변. 그리드 타일(최대 5열) 용도로 충분하고 한 장에 10~20KB.
  const THUMB_PX = 320;
  const COLUMN_OPTIONS = [0, 3, 4, 5]; // 0 = 자동(창 폭에 맞춰)
  // 메시지로 이동할 때 과거를 거슬러 올라가는 최대 시간
  const JUMP_MAX_MS = 120_000;
  const ROOM_STATS_TTL_NOTE_MS = 60_000;
  const MODE_LABEL = { conversation: "대화", roleplay: "RP", game: "게임" };
  // 2단계(삭제·WebP 축소)
  const QUALITY_MIN = 60;
  const QUALITY_MAX = 100;
  const QUALITY_STEP = 5;
  const EDGE_OPTIONS = [0, 1280, 1600, 2048]; // 긴 변 상한, 0 = 제한 없음
  // 작업 중에는 60초마다 잠금 표를 갱신한다. 3분 넘게 갱신이 없으면 끊긴 작업으로 보고 무시한다.
  const REMOTE_LOCK_STALE_MS = 3 * 60_000;
  const OWN_LOCK_KEY = "sim-own-lock-token"; // 새로고침으로 끊긴 내 작업 표를 알아보기 위한 탭 단위 기억
  const INSTANCE_ID = Math.random().toString(36).slice(2, 10);

  const DEFAULTS = Object.freeze({
    columns: 0,
    sort: "newest", // "newest" | "oldest"
    quality: 85, // WebP 품질
    maxEdge: 1600, // 긴 변 상한(px), 0 = 제한 없음
    roomStats: {}, // chatId → { n: 사진 수, b: 바이트, at: ISO 읽은 시각 }
  });

  const SVG = {
    trash:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>',
    shrink:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 15 6 6"/><path d="m15 9 6-6"/><path d="M21 16v5h-5"/><path d="M21 8V3h-5"/><path d="M3 16v5h5"/><path d="m3 21 6-6"/><path d="M3 8V3h5"/><path d="M9 9 3 3"/></svg>',
    images:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 22H4a2 2 0 0 1-2-2V6"/><path d="m22 13-1.296-1.296a2.41 2.41 0 0 0-3.408 0L11 18"/><circle cx="12" cy="8" r="2"/><rect width="16" height="16" x="6" y="2" rx="2"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    check:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    download:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>',
    jump: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
    refresh:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    sort: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="m21 8-4-4-4 4"/><path d="M17 4v16"/></svg>',
  };

  const state = {
    settings: { ...DEFAULTS, roomStats: {} },
    settingsLoaded: false,
    rooms: [], // { id, name, mode, updatedAt }
    roomsLoadedAt: 0,
    scope: null, // "all" | chatId
    scans: new Map(), // chatId → scan
    scanRun: null, // 진행 중인 읽기 { cancelled, chatIds }
    selecting: false,
    selected: new Set(), // entry.key
    fab: null,
    win: null,
    lightbox: null,
    renderTimer: null,
    gridScrollTop: 0,
    busy: null, // 다운로드 같은 짧은 작업 표시
    run: null, // 진행 중인 삭제·변환 작업
    lastRun: null, // 마지막 작업 결과(상태 줄에 표시)
    remoteLockInfo: null, // 다른 탭·기기의 작업 표(거절됐을 때 상태 줄에서 지울 수 있게)
  };

  const cleanupFns = [];
  const onCleanup = (fn) => cleanupFns.push(fn);

  const log = {
    info: (...a) => marinara.log?.info?.(`[${EXT_NAME}]`, ...a),
    warn: (...a) => marinara.log?.warn?.(`[${EXT_NAME}]`, ...a),
    error: (...a) => marinara.log?.error?.(`[${EXT_NAME}]`, ...a),
  };

  // ───────────────────────── 유틸 ─────────────────────────

  function readActiveChatId() {
    try {
      return localStorage.getItem(ACTIVE_CHAT_KEY) || null;
    } catch {
      return null;
    }
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return "?";
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
    return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  }

  const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];
  function dateKey(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "날짜 없음";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day} (${WEEKDAY[d.getDay()]})`;
  }
  function fmtDateTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${dateKey(iso)} ${hh}:${mm}`;
  }
  function fmtAgo(iso) {
    const t = Date.parse(iso || "");
    if (!t) return "";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return "방금";
    if (s < 3600) return `${Math.floor(s / 60)}분 전`;
    if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
    return `${Math.floor(s / 86400)}일 전`;
  }

  function esc(text) {
    return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function parseExtra(extra) {
    if (!extra) return {};
    if (typeof extra === "string") {
      try {
        const parsed = JSON.parse(extra);
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        return {};
      }
    }
    return typeof extra === "object" ? extra : {};
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 화면에 양보. 인앱 브라우저처럼 탭이 숨김 상태여도 멈추지 않도록 rAF가 아니라 setTimeout을 쓴다.
  const nextTick = () => sleep(0);

  function typeLabel(mime) {
    const m = String(mime || "").toLowerCase();
    if (m.includes("png")) return "PNG";
    if (m.includes("jpeg") || m.includes("jpg")) return "JPG";
    if (m.includes("webp")) return "WEBP";
    if (m.includes("gif")) return "GIF";
    if (m.includes("avif")) return "AVIF";
    return m.replace(/^image\//, "").toUpperCase() || "?";
  }
  function extOf(mime) {
    const m = String(mime || "").toLowerCase();
    if (m.includes("png")) return "png";
    if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
    if (m.includes("webp")) return "webp";
    if (m.includes("gif")) return "gif";
    if (m.includes("avif")) return "avif";
    return "img";
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  // ───────────────────────── API ─────────────────────────

  const doFetch = typeof marinara.fetch === "function" ? marinara.fetch : window.fetch.bind(window);

  // 서버는 1분에 600회까지만 받는다(그 뒤 429). 그 아래로 속도를 맞추고 429가 오면 쉬었다 다시 보낸다.
  const REQUEST_WINDOW_MS = 60_000;
  const REQUEST_BUDGET = 420;
  const requestTimes = [];
  async function throttle() {
    const now = Date.now();
    while (requestTimes.length && now - requestTimes[0] > REQUEST_WINDOW_MS) requestTimes.shift();
    if (requestTimes.length >= REQUEST_BUDGET) {
      const wait = REQUEST_WINDOW_MS - (now - requestTimes[0]) + 200;
      setNote(`서버 요청 제한에 맞춰 ${Math.ceil(wait / 1000)}초 쉬는 중`);
      await sleep(wait);
      setNote(null);
      return throttle();
    }
    requestTimes.push(Date.now());
  }

  async function api(method, path, body, { attempt = 0 } = {}) {
    const headers = { "x-marinara-csrf": "1" };
    const init = { method, headers, cache: "no-store", credentials: "same-origin" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    await throttle();
    const res = await doFetch(`/api${path}`, init);
    if (res.status === 429 && attempt < 5) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(60_000, 5_000 * 2 ** attempt);
      setNote(`서버 요청 제한(429), ${Math.ceil(wait / 1000)}초 뒤 다시 시도`);
      await sleep(wait);
      setNote(null);
      return api(method, path, body, { attempt: attempt + 1 });
    }
    if (!res.ok) {
      let detail = "";
      try {
        const j = await res.json();
        if (j && j.error) detail = ` - ${j.error}`;
      } catch {
        /* ignore */
      }
      const error = new Error(`${method} ${path} 실패 (${res.status}${detail})`);
      error.status = res.status;
      throw error;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  function cursorOf(message) {
    return `${message.createdAt}|${encodeURIComponent(message.id)}`;
  }

  // ───────────────────────── 설정 ─────────────────────────

  async function loadSettings() {
    if (state.settingsLoaded) return state.settings;
    try {
      const saved = await marinara.storage.get();
      if (saved && typeof saved === "object") {
        const next = { ...DEFAULTS, roomStats: {} };
        if (COLUMN_OPTIONS.includes(saved.columns)) next.columns = saved.columns;
        if (saved.sort === "oldest" || saved.sort === "newest") next.sort = saved.sort;
        if (Number.isFinite(saved.quality)) next.quality = clampQuality(saved.quality);
        if (EDGE_OPTIONS.includes(saved.maxEdge)) next.maxEdge = saved.maxEdge;
        if (saved.roomStats && typeof saved.roomStats === "object") next.roomStats = { ...saved.roomStats };
        state.settings = next;
      }
    } catch (error) {
      log.warn("설정을 읽지 못했습니다", error);
    }
    state.settingsLoaded = true;
    return state.settings;
  }

  async function saveSettings(patch) {
    Object.assign(state.settings, patch);
    try {
      await marinara.storage.patch(patch);
    } catch (error) {
      log.warn("설정 저장 실패", error);
    }
  }

  async function saveRoomStat(chatId, scan) {
    const roomStats = { ...state.settings.roomStats };
    roomStats[chatId] = { n: scan.items.length, b: scan.bytes, at: new Date().toISOString() };
    await saveSettings({ roomStats });
  }

  // ───────────────────────── 알림·대화상자 ─────────────────────────

  let toastHost = null;
  function toast(message, kind = "info", ms = 3200) {
    if (!toastHost) {
      toastHost = document.createElement("div");
      toastHost.className = "sim-toast-host";
      toastHost.setAttribute("data-chat-floating-panel", "");
      document.body.appendChild(toastHost);
    }
    const el = document.createElement("div");
    el.className = `sim-toast sim-toast--${kind}`;
    el.textContent = message;
    toastHost.appendChild(el);
    requestAnimationFrame(() => el.classList.add("sim-toast--in"));
    const remove = () => {
      el.classList.remove("sim-toast--in");
      setTimeout(() => el.remove(), 250);
    };
    const timer = setTimeout(remove, ms);
    return {
      remove: () => {
        clearTimeout(timer);
        remove();
      },
    };
  }

  function confirmDialog({ title, message, confirmLabel = "확인", danger = false }) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "sim-overlay";
      overlay.setAttribute("data-chat-floating-panel", "");
      overlay.innerHTML = `
        <div class="sim-dialog" role="dialog" aria-modal="true">
          <h3 class="sim-dialog__title"></h3>
          <p class="sim-dialog__message"></p>
          <div class="sim-dialog__actions">
            <button type="button" class="sim-btn" data-act="cancel">취소</button>
            <button type="button" class="sim-btn sim-btn--primary" data-act="ok"></button>
          </div>
        </div>`;
      overlay.querySelector(".sim-dialog__title").textContent = title;
      overlay.querySelector(".sim-dialog__message").textContent = message;
      const ok = overlay.querySelector('[data-act="ok"]');
      ok.textContent = confirmLabel;
      if (danger) ok.classList.add("sim-btn--danger");
      const done = (value) => {
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          done(false);
        }
      };
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) done(false);
      });
      overlay.querySelector('[data-act="cancel"]').addEventListener("click", () => done(false));
      ok.addEventListener("click", () => done(true));
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(overlay);
      ok.focus();
    });
  }

  // ───────────────────────── 마리나라 화면 연동 ─────────────────────────

  let cachedQueryClient = null;
  function findQueryClient() {
    if (cachedQueryClient) return cachedQueryClient;
    const container = document.getElementById("root");
    if (!container) return null;
    const key = Object.keys(container).find((n) => n.startsWith("__reactContainer$") || n.startsWith("__reactFiber$"));
    if (!key) return null;
    const queue = [container[key]];
    let steps = 0;
    while (queue.length && steps < 600) {
      const node = queue.shift();
      steps += 1;
      if (!node) continue;
      const client = node.memoizedProps?.client;
      if (client && typeof client.invalidateQueries === "function") {
        cachedQueryClient = client;
        return client;
      }
      if (node.child) queue.push(node.child);
      if (node.sibling) queue.push(node.sibling);
    }
    return null;
  }

  function refreshMessages(chatId) {
    try {
      const client = findQueryClient();
      if (!client) return false;
      void client.invalidateQueries({ queryKey: ["chats", "messages", chatId] });
      return true;
    } catch (error) {
      log.warn("화면 갱신 요청 실패", error);
      return false;
    }
  }

  /**
   * 엔진의 메시지 캐시(열린 방의 무한 쿼리)에 목표 메시지가 들어올 때까지 과거 페이지를 50개 단위로 받아 한 번에 붙인다.
   * "loaded" = 캐시에 있음, "missing" = 그 시각까지 받았는데 없음(지워짐), "end" = 끝까지 받았는데 없음,
   * "no-query" = 캐시를 못 찾음(엔진 버튼 방식으로 대신한다).
   */
  async function loadMessagesUntil(entry) {
    const client = findQueryClient();
    if (!client) return "no-query";
    const queryKey = ["chats", "messages", entry.chatId];
    const query = client.getQueryCache().find({ queryKey });
    const data = query?.state?.data;
    if (!data || !Array.isArray(data.pages)) return "no-query";
    const has = (pages) => pages.some((p) => Array.isArray(p) && p.some((m) => m && m.id === entry.messageId));
    if (has(data.pages)) return "loaded";
    const lastPage = data.pages[data.pages.length - 1];
    const oldest = Array.isArray(lastPage) ? lastPage[0] : null;
    if (!oldest) return "end";
    const targetTime = Date.parse(entry.createdAt) || 0;
    let cursor = cursorOf(oldest);
    const newPages = [];
    const newParams = [];
    let result = "end";
    for (let i = 0; i < 400; i += 1) {
      const page = await api("GET", `/chats/${entry.chatId}/messages?limit=${PAGE_SIZE}&before=${cursor}`);
      if (!Array.isArray(page) || page.length === 0) break;
      newPages.push(page);
      newParams.push(cursor);
      if (page.some((m) => m && m.id === entry.messageId)) {
        result = "loaded";
        break;
      }
      const pageOldestTime = Date.parse(page[0]?.createdAt) || 0;
      if (targetTime && pageOldestTime && pageOldestTime < targetTime) {
        result = "missing";
        break;
      }
      if (page.length < PAGE_SIZE) break;
      cursor = cursorOf(page[0]);
      await nextTick();
    }
    if (newPages.length) {
      client.setQueryData(queryKey, (old) => {
        if (!old || !Array.isArray(old.pages)) return old;
        // 그 사이 엔진이 더 받았으면 겹치는 메시지는 빼고 붙인다
        const known = new Set();
        for (const p of old.pages) for (const m of p || []) if (m && m.id) known.add(m.id);
        const pages = [...old.pages];
        const pageParams = [...(old.pageParams || [])];
        newPages.forEach((p, i) => {
          const fresh = p.filter((m) => m && !known.has(m.id));
          if (!fresh.length) return;
          pages.push(fresh);
          pageParams.push(newParams[i]);
        });
        return { ...old, pages, pageParams };
      });
    }
    return result;
  }

  /** DOM이 바뀔 때마다 조건을 확인하고, 참이 되면 바로 끝난다(최대 timeoutMs). 돌려주는 값은 조건의 결과. */
  function waitDom(predicate, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(value);
      };
      const check = () => {
        let v = null;
        try {
          v = predicate();
        } catch {
          v = null;
        }
        if (v) finish(v);
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "class"] });
      const timer = setTimeout(() => finish(predicate() || null), timeoutMs);
      check();
    });
  }

  // ───────────────────────── 이미지 도우미 ─────────────────────────

  /** data: URL의 MIME과 바이트 수를 base64 길이로 계산한다(디코딩 없이). */
  function dataUrlInfo(data) {
    if (typeof data !== "string" || !data.startsWith("data:")) return null;
    const comma = data.indexOf(",");
    if (comma < 0) return null;
    const head = data.slice(5, comma);
    const semi = head.indexOf(";");
    const mime = (semi >= 0 ? head.slice(0, semi) : head).toLowerCase();
    if (!head.includes("base64")) return null;
    const b64len = data.length - comma - 1;
    let pad = 0;
    if (data.endsWith("==")) pad = 2;
    else if (data.endsWith("=")) pad = 1;
    const bytes = Math.max(0, Math.floor((b64len * 3) / 4) - pad);
    return { mime, bytes, comma };
  }

  function isSentImage(att) {
    if (!att || typeof att !== "object") return false;
    const type = typeof att.type === "string" ? att.type.toLowerCase() : "";
    const data = att.data;
    if (typeof data !== "string" || !data.startsWith("data:image/")) return false;
    // 생성 삽화는 type "image" + url 이라 여기 걸리지 않는다. type이 비어 있어도 data가 이미지면 포함.
    return type === "" || type.startsWith("image/") || type === "image";
  }

  /** 교체·삭제 전에 "그 사이 바뀌지 않았는지" 비교하는 가벼운 지문. */
  function fingerprintOf(data, bytes) {
    return `${bytes}:${data.slice(-40)}:${data.length}`;
  }

  async function dataUrlToBlob(data) {
    try {
      const res = await fetch(data);
      return await res.blob();
    } catch {
      const comma = data.indexOf(",");
      const bin = atob(data.slice(comma + 1));
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
      const mime = data.slice(5, data.indexOf(";")) || "application/octet-stream";
      return new Blob([arr], { type: mime });
    }
  }

  /** 파일 머리만 읽어 가로세로를 알아낸다(PNG·JPEG·WebP·GIF). 모르면 null. */
  function readDims(u8) {
    const n = u8.length;
    const be32 = (i) => ((u8[i] << 24) | (u8[i + 1] << 16) | (u8[i + 2] << 8) | u8[i + 3]) >>> 0;
    const le16 = (i) => u8[i] | (u8[i + 1] << 8);
    const le24 = (i) => u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16);
    try {
      // PNG
      if (n > 24 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
        return { width: be32(16), height: be32(20) };
      }
      // GIF
      if (n > 10 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) {
        return { width: le16(6), height: le16(8) };
      }
      // WebP
      if (n > 30 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45) {
        const fourcc = String.fromCharCode(u8[12], u8[13], u8[14], u8[15]);
        if (fourcc === "VP8X") return { width: 1 + le24(24), height: 1 + le24(27) };
        if (fourcc === "VP8L") {
          const b0 = u8[21], b1 = u8[22], b2 = u8[23], b3 = u8[24];
          return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
        }
        if (fourcc === "VP8 ") return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
        return null;
      }
      // JPEG: SOF 마커를 찾는다
      if (n > 4 && u8[0] === 0xff && u8[1] === 0xd8) {
        let i = 2;
        while (i + 9 < n) {
          if (u8[i] !== 0xff) {
            i += 1;
            continue;
          }
          const marker = u8[i + 1];
          if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            i += 2;
            continue;
          }
          const len = (u8[i + 2] << 8) | u8[i + 3];
          if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { height: (u8[i + 5] << 8) | u8[i + 6], width: (u8[i + 7] << 8) | u8[i + 8] };
          }
          if (len < 2) return null;
          i += 2 + len;
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  /** 썸네일(object URL)과 원본 크기. 머리에서 크기를 알면 줄여서 디코딩해 빠르다. */
  async function makeThumb(blob) {
    let dims = null;
    try {
      const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
      dims = readDims(head);
      if (dims && (!(dims.width > 0) || !(dims.height > 0))) dims = null;
    } catch {
      dims = null;
    }
    let bitmap;
    if (dims) {
      const scale = Math.min(1, THUMB_PX / Math.max(dims.width, dims.height));
      bitmap =
        scale < 1
          ? await createImageBitmap(blob, {
              resizeWidth: Math.max(1, Math.round(dims.width * scale)),
              resizeHeight: Math.max(1, Math.round(dims.height * scale)),
              resizeQuality: "medium",
            })
          : await createImageBitmap(blob);
    } else {
      bitmap = await createImageBitmap(blob);
      dims = { width: bitmap.width, height: bitmap.height };
    }
    try {
      const scale = Math.min(1, THUMB_PX / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      let out = await new Promise((r) => canvas.toBlob(r, "image/webp", 0.8));
      if (!out) out = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.8));
      return { url: out ? URL.createObjectURL(out) : null, width: dims.width, height: dims.height };
    } finally {
      bitmap.close?.();
    }
  }

  // ───────────────────────── 방 목록 ─────────────────────────

  async function loadRooms({ force = false } = {}) {
    if (!force && state.rooms.length && Date.now() - state.roomsLoadedAt < 60_000) return state.rooms;
    const rows = await api("GET", "/chats");
    state.rooms = (Array.isArray(rows) ? rows : [])
      .map((c) => ({
        id: c.id,
        name: (typeof c.name === "string" && c.name.trim()) || (typeof c.title === "string" && c.title.trim()) || "(이름 없음)",
        mode: typeof c.mode === "string" ? c.mode : "",
        updatedAt: c.updatedAt || c.createdAt || "",
      }))
      .filter((c) => typeof c.id === "string" && c.id);
    state.roomsLoadedAt = Date.now();
    return state.rooms;
  }

  function roomById(chatId) {
    return state.rooms.find((r) => r.id === chatId) || null;
  }
  function roomName(chatId) {
    return roomById(chatId)?.name || "(알 수 없는 방)";
  }

  // ───────────────────────── 메시지 읽기(스캔) ─────────────────────────

  function newScan(chatId) {
    return {
      chatId,
      status: "idle", // idle | running | done | error | cancelled
      pages: 0,
      totalPages: 0,
      messageCount: 0,
      items: [],
      bytes: 0,
      error: null,
      startedAt: 0,
      finishedAt: 0,
    };
  }

  function releaseScan(scan) {
    for (const it of scan.items) if (it.thumb) URL.revokeObjectURL(it.thumb);
    scan.items = [];
    scan.bytes = 0;
  }

  function setNote(note) {
    state.note = note;
    scheduleRender({ statusOnly: true });
  }

  /** 첨부 배열에서 보낸 사진을 골라 썸네일을 만들고 목록에 넣는다. swipeIndex가 null이면 메시지 행의 첨부. */
  async function collectEntries(scan, run, m, atts, swipeIndex, ctx) {
    for (let idx = 0; idx < atts.length; idx += 1) {
      if (run.cancelled) return;
      const att = atts[idx];
      if (!isSentImage(att)) continue;
      const info = dataUrlInfo(att.data);
      if (!info) continue;
      const fp = fingerprintOf(att.data, info.bytes);
      if (swipeIndex !== null) {
        // 비활성 버전에 같은 사진이 그대로 있으면(거울 사본) 타일을 또 만들지 않고 본체에 기록해 둔다.
        // 삭제·변환 때 함께 처리한다.
        const twin = scan.items.find((e) => e.messageId === m.id && e.swipeIndex === null && e.fp === fp);
        if (twin) {
          twin.mirrors.push({ swipeIndex, idx });
          continue;
        }
      }
      const entry = {
        hasText: typeof m.content === "string" && m.content.trim().length > 0,
        attachmentTotal: atts.length,
        mirrors: [], // 비활성 버전에 든 같은 사진의 자리 [{swipeIndex, idx}]
        key: `${scan.chatId}:${m.id}:${swipeIndex === null ? "" : `s${swipeIndex}`}:${idx}`,
        chatId: scan.chatId,
        messageId: m.id,
        msgNo: ctx.msgNo,
        idx,
        swipeIndex, // null = 메시지 행(활성 버전), 숫자 = 비활성 답변 버전 안의 사진
        role: m.role || "",
        type: info.mime || (typeof att.type === "string" ? att.type : ""),
        bytes: info.bytes,
        width: 0,
        height: 0,
        createdAt: m.createdAt || "",
        filename: typeof att.filename === "string" ? att.filename : typeof att.name === "string" ? att.name : "",
        caption: typeof att.caption === "string" ? att.caption : "",
        swipeCount: ctx.swipeCount,
        fp,
        thumb: null,
        fetchCursor: ctx.successor,
        pageCursor: ctx.pageCursor,
      };
      try {
        const blob = await dataUrlToBlob(att.data);
        const t = await makeThumb(blob);
        entry.thumb = t.url;
        entry.width = t.width;
        entry.height = t.height;
      } catch (error) {
        log.warn("썸네일 실패", entry.key, error);
      }
      scan.items.push(entry);
      scan.bytes += entry.bytes;
      scheduleRender();
      await nextTick();
    }
  }

  /**
   * 한 방의 메시지를 최신부터 페이지 단위로 읽어 사진만 모은다. 페이지 사이·사진 사이마다 화면에 양보한다.
   * 원본 base64는 썸네일을 만든 뒤 버리고, 다시 필요할 때 쓸 커서만 기억한다.
   */
  async function scanRoom(chatId, run) {
    const prev = state.scans.get(chatId);
    if (prev) releaseScan(prev);
    const scan = newScan(chatId);
    scan.status = "running";
    scan.startedAt = Date.now();
    state.scans.set(chatId, scan);
    scheduleRender();
    try {
      try {
        const counted = await api("GET", `/chats/${chatId}/message-count`);
        scan.messageCount = Number(counted?.count) || 0;
        scan.totalPages = Math.max(1, Math.ceil(scan.messageCount / PAGE_SIZE));
      } catch {
        scan.totalPages = 0;
      }
      let cursor = null; // 이 페이지를 받을 때 쓴 커서(null = 첫 페이지)
      let seen = 0;
      for (;;) {
        if (run.cancelled) {
          scan.status = "cancelled";
          break;
        }
        const qs = cursor ? `?limit=${PAGE_SIZE}&before=${cursor}` : `?limit=${PAGE_SIZE}`;
        const page = await api("GET", `/chats/${chatId}/messages${qs}`);
        if (!Array.isArray(page) || page.length === 0) break;
        scan.pages += 1;
        // 페이지 안은 오래된 순. 최신부터 보여 주려고 뒤에서부터 돈다.
        for (let p = page.length - 1; p >= 0; p -= 1) {
          if (run.cancelled) break;
          const m = page[p];
          seen += 1;
          const extra = parseExtra(m.extra);
          const atts = Array.isArray(extra.attachments) ? extra.attachments : [];
          const swipeCount = Number(m.swipeCount) || 0;
          if (!atts.length && swipeCount < 2) continue;
          const ctx = {
            successor: p + 1 < page.length ? cursorOf(page[p + 1]) : cursor, // 이 커서로 limit=1을 받으면 정확히 이 메시지가 온다
            pageCursor: cursor,
            msgNo: Number.isFinite(m.rowid) ? m.rowid : scan.messageCount ? scan.messageCount - seen + 1 : null,
            swipeCount,
          };
          // 메시지 행의 첨부(= 활성 스와이프와 같은 내용)
          await collectEntries(scan, run, m, atts, null, ctx);
          // 답변 버전(스와이프)이 둘 이상이면 비활성 버전 안의 사진도 읽는다. 활성 버전은 메시지 행과 같아 건너뛴다.
          if (swipeCount > 1) {
            try {
              const swipes = await api("GET", `/chats/${chatId}/messages/${m.id}/swipes`);
              const active = Number.isFinite(m.activeSwipeIndex) ? m.activeSwipeIndex : 0;
              for (const sw of Array.isArray(swipes) ? swipes : []) {
                if (!sw || sw.index === active) continue;
                const swAtts = parseExtra(sw.extra).attachments;
                if (Array.isArray(swAtts) && swAtts.length) await collectEntries(scan, run, m, swAtts, sw.index, ctx);
              }
            } catch (error) {
              log.warn("스와이프 읽기 실패", m.id, error);
            }
          }
        }
        // 다음 페이지 커서 = 이 페이지에서 가장 오래된 메시지
        const oldest = page[0];
        const next = cursorOf(oldest);
        if (page.length < PAGE_SIZE || next === cursor) break;
        cursor = next;
        scheduleRender({ statusOnly: true });
        await nextTick();
      }
      if (scan.status === "running") scan.status = "done";
    } catch (error) {
      scan.status = "error";
      scan.error = error?.message || String(error);
      log.error("읽기 실패", chatId, error);
    }
    scan.finishedAt = Date.now();
    if (scan.status === "done") await saveRoomStat(chatId, scan);
    scheduleRender();
    return scan;
  }

  async function startScan(chatIds) {
    if (state.scanRun && !state.scanRun.cancelled) {
      toast("이미 읽는 중입니다", "info");
      return;
    }
    const run = { cancelled: false, chatIds, current: null };
    state.scanRun = run;
    scheduleRender();
    try {
      for (const chatId of chatIds) {
        if (run.cancelled) break;
        run.current = chatId;
        await scanRoom(chatId, run);
      }
    } finally {
      if (state.scanRun === run) state.scanRun = null;
      state.note = null;
      scheduleRender();
    }
  }

  function cancelScan() {
    if (state.scanRun) state.scanRun.cancelled = true;
  }

  // ───────────────────────── 원본 다시 받기 ─────────────────────────

  /** 사진이 든 메시지 한 개를 서버에서 다시 받는다. 못 찾으면 null. */
  async function fetchMessageRow(entry) {
    const tryQs = async (qs) => {
      try {
        const rows = await api("GET", `/chats/${entry.chatId}/messages${qs}`);
        return Array.isArray(rows) ? rows.find((r) => r.id === entry.messageId) || null : null;
      } catch (error) {
        if (error.status === 400) return null; // 커서 메시지가 사라짐
        throw error;
      }
    };
    const one = await tryQs(entry.fetchCursor ? `?limit=1&before=${entry.fetchCursor}` : "?limit=1");
    if (one) return one;
    return tryQs(entry.pageCursor ? `?limit=${PAGE_SIZE}&before=${entry.pageCursor}` : `?limit=${PAGE_SIZE}`);
  }

  /** 원본 data URL. 메시지가 바뀌었으면 지문으로 같은 첨부를 찾고, 없으면 오류. */
  async function fetchOriginal(entry) {
    const row = await fetchMessageRow(entry);
    if (!row) throw new Error("메시지를 찾지 못했습니다. 그 사이 지워졌거나 바뀌었을 수 있으니 다시 읽어 주세요");
    let holder = row; // 첨부 배열을 가진 쪽: 메시지 행 또는 비활성 스와이프
    if (entry.swipeIndex !== null && entry.swipeIndex !== undefined) {
      const swipes = await api("GET", `/chats/${entry.chatId}/messages/${entry.messageId}/swipes`);
      holder = (Array.isArray(swipes) ? swipes : []).find((s) => s && s.index === entry.swipeIndex) || null;
      if (!holder) throw new Error("이 답변 버전(스와이프)이 사라졌습니다. 다시 읽어 주세요");
    }
    const atts = parseExtra(holder.extra).attachments;
    const list = Array.isArray(atts) ? atts : [];
    let att = list[entry.idx];
    if (!att || !isSentImage(att) || fingerprintOf(att.data, dataUrlInfo(att.data)?.bytes ?? -1) !== entry.fp) {
      att = list.find((a) => isSentImage(a) && fingerprintOf(a.data, dataUrlInfo(a.data)?.bytes ?? -1) === entry.fp) || null;
    }
    if (!att) throw new Error("이 사진이 메시지에서 바뀌었거나 지워졌습니다. 다시 읽어 주세요");
    return { dataUrl: att.data, row, holder, attachment: att };
  }

  function downloadName(entry) {
    const raw = (entry.filename || "").trim();
    const safe = raw.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);
    if (safe && /\.[a-z0-9]{2,5}$/i.test(safe)) return safe;
    const d = new Date(entry.createdAt);
    const stamp = Number.isNaN(d.getTime())
      ? "날짜없음"
      : `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
    return `${safe || "보낸사진"}_${stamp}_${entry.msgNo ?? "x"}-${entry.idx + 1}.${extOf(entry.type)}`;
  }

  async function downloadEntry(entry) {
    const { dataUrl } = await fetchOriginal(entry);
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = downloadName(entry);
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function downloadMany(entries) {
    let ok = 0;
    let failed = 0;
    state.busy = { label: "다운로드", done: 0, total: entries.length };
    scheduleRender({ statusOnly: true });
    try {
      for (const entry of entries) {
        try {
          await downloadEntry(entry);
          ok += 1;
        } catch (error) {
          failed += 1;
          log.warn("다운로드 실패", entry.key, error);
        }
        state.busy.done += 1;
        scheduleRender({ statusOnly: true });
        // 브라우저가 연속 다운로드를 하나로 뭉개지 않도록 조금 쉰다
        await sleep(350);
      }
    } finally {
      state.busy = null;
      scheduleRender({ statusOnly: true });
    }
    toast(failed ? `다운로드 ${ok}장, 실패 ${failed}장` : `${ok}장 다운로드를 시작했습니다`, failed ? "error" : "success");
  }

  // ───────────────────────── 메시지로 이동 ─────────────────────────

  function findMessageEl(messageId) {
    try {
      return document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    } catch {
      return null;
    }
  }

  function jumpTrace(step) {
    try {
      if (!localStorage.getItem("sim-debug")) return;
      (window.__simJumpTrace = window.__simJumpTrace || []).push(`${Date.now() % 100000} ${step}`);
    } catch {
      /* ignore */
    }
  }

  /** 엔진의 "이전 메시지 보기(n)" 버튼. 같은 모양의 "더 불러오기" 버튼은 .mari-chat-load-more 안에 있어 구분된다. */
  function olderButton() {
    for (const b of document.querySelectorAll("button.mari-chat-history-pager")) {
      if (b.closest(".mari-chat-load-more")) continue;
      if (b.querySelector("svg.lucide-chevron-up")) return b;
    }
    return null;
  }

  function olderButtonLabel() {
    const b = olderButton();
    return b ? b.textContent.trim() : "";
  }

  function flashMessage(el) {
    // 멀리 있으면 부드러운 스크롤이 몇 초씩 걸리므로 바로 옮기고, 가까우면 부드럽게
    const far = Math.abs(el.getBoundingClientRect().top - window.innerHeight / 2) > 3000;
    el.scrollIntoView({ behavior: far ? "auto" : "smooth", block: "center" });
    el.classList.add("sim-jump-hl");
    setTimeout(() => el.classList.remove("sim-jump-hl"), 2200);
  }

  async function jumpToMessage(entry) {
    const tag = entry.msgNo ? `#${entry.msgNo}` : "";
    const active = readActiveChatId();
    if (active !== entry.chatId) {
      const copied = tag ? await copyText(tag) : false;
      toast(
        `${roomName(entry.chatId)} 방을 먼저 열어 주세요${copied ? `. 메시지 번호 ${tag}를 복사했으니 그 방의 메시지 검색창에 붙여 넣으면 이동합니다` : ""}`,
        "info",
        6000,
      );
      return;
    }
    closeLightbox();
    closeWindow();
    await sleep(50);
    // 엔진 화면은 (1) 메시지 캐시에 받아 둔 페이지 중 일부(기본 80개)만 그리는 "이전 메시지 보기" 창과
    // (2) 과거 페이지를 더 받는 "더 불러오기"의 두 단계로 과거를 보여 준다. 엔진의 #번호 이동은 20개짜리 페이지를
    // 하나씩 받아 매번 다시 그리므로 큰 방에서는 수십 초가 걸린다. 여기서는 (2)를 직접 한다: 목표 메시지가 나올 때까지
    // 50개 페이지로 받아 엔진의 메시지 캐시에 한 번에 붙이고, 그 다음 (1)의 버튼을 눌러 창을 목표까지 넓힌다.
    const progress = toast(`${tag ? `${tag} ` : ""}메시지로 이동 중…`, "info", JUMP_MAX_MS);
    const deadline = Date.now() + JUMP_MAX_MS;
    let found = findMessageEl(entry.messageId);
    let loadResult = found ? "loaded" : null;
    if (!found) {
      try {
        loadResult = await loadMessagesUntil(entry);
      } catch (error) {
        log.warn("메시지 캐시 채우기 실패", error);
        loadResult = "error";
      }
      jumpTrace(`load ${loadResult}`);
    }
    if (!found && loadResult !== "loaded") {
      // 캐시를 직접 못 채우면(화면 구성이 다른 경우) 엔진 버튼으로 천천히 간다
      let stalled = 0;
      while (Date.now() < deadline && !found) {
        found = findMessageEl(entry.messageId);
        if (found) break;
        const older = olderButton();
        if (older) {
          const olderLabel = olderButtonLabel();
          older.click();
          await waitDom(() => findMessageEl(entry.messageId) || olderButtonLabel() !== olderLabel, 1500);
          continue;
        }
        const more = document.querySelector(".mari-chat-load-more button");
        if (!more) break;
        if (more.disabled) {
          await sleep(200);
          continue;
        }
        const first = document.querySelector("[data-message-id]")?.getAttribute("data-message-id") || "";
        more.click();
        const changed = await waitDom(
          () =>
            findMessageEl(entry.messageId) ||
            olderButton() ||
            (document.querySelector("[data-message-id]")?.getAttribute("data-message-id") || "") !== first ||
            !document.querySelector(".mari-chat-load-more button"),
          15_000,
        );
        stalled = changed ? 0 : stalled + 1;
        if (stalled >= 3) break;
      }
    }
    // 캐시에는 있지만 아직 그려지지 않았으면 "이전 메시지 보기"를 눌러 창을 넓힌다(한 번에 40개).
    let olderClicks = 0;
    while (!found && Date.now() < deadline) {
      found = findMessageEl(entry.messageId);
      if (found) break;
      const older = olderButton();
      if (!older) {
        // 다시 그리는 중일 수 있으니 잠깐 더 기다려 본다
        const appeared = await waitDom(() => findMessageEl(entry.messageId) || olderButton(), 1500);
        if (!appeared) break;
        continue;
      }
      const olderLabel = olderButtonLabel();
      older.click();
      olderClicks += 1;
      await waitDom(() => findMessageEl(entry.messageId) || olderButtonLabel() !== olderLabel, 1500);
    }
    jumpTrace(`end found=${!!found} olderClicks=${olderClicks} elapsed=${Math.round((Date.now() - (deadline - JUMP_MAX_MS)) / 1000)}s`);
    progress.remove();
    if (found) {
      flashMessage(found);
      return;
    }
    const copied = tag ? await copyText(tag) : false;
    toast(
      copied
        ? `메시지를 화면에서 찾지 못했습니다. 번호 ${tag}를 복사했으니 메시지 검색창에 붙여 넣으면 이동합니다`
        : "메시지를 화면에서 찾지 못했습니다",
      "info",
      6000,
    );
  }

  // ───────────────────────── 2단계: 삭제 · WebP 축소 ─────────────────────────

  function clampQuality(q) {
    const n = Math.round(Number(q) / QUALITY_STEP) * QUALITY_STEP;
    return Math.max(QUALITY_MIN, Math.min(QUALITY_MAX, Number.isFinite(n) ? n : 85));
  }

  /** 작업을 멈추고 그 장을 그대로 둬야 하는 상황. 실패가 아니라 "건너뜀"으로 집계한다. */
  class SkipError extends Error {
    constructor(reason) {
      super(reason);
      this.name = "SkipError";
      this.skip = true;
    }
  }

  // ── 생성 중 감지 (열린 방의 보내기 버튼이 중지 아이콘이면 생성 중) ──
  function chatIsGenerating() {
    const STOP_ICON = "button svg.lucide-stop-circle, button svg.lucide-circle-stop";
    if (document.querySelector(".mari-chat-send-btn svg.lucide-stop-circle, .mari-chat-send-btn svg.lucide-circle-stop")) return true;
    let scope = document.querySelector("textarea[data-chat-composer]");
    for (let depth = 0; scope && depth < 6; depth += 1) {
      if (scope.querySelector(STOP_ICON)) return true;
      scope = scope.parentElement;
    }
    return false;
  }

  async function waitForQuiet(run, maxMs = 60_000) {
    const until = Date.now() + maxMs;
    while (chatIsGenerating() && Date.now() < until && !run.cancelled) {
      run.note = "열린 방에서 생성이 끝나길 기다리는 중";
      scheduleRender({ statusOnly: true });
      await sleep(1500);
    }
    run.note = null;
    return !chatIsGenerating();
  }

  // ── 다른 탭·기기와의 잠금 (확장 저장소에 표를 적는다) ──
  async function readRemoteLock() {
    const saved = await marinara.storage.get();
    return saved && typeof saved === "object" && saved.runLock && typeof saved.runLock === "object" ? saved.runLock : null;
  }
  function ownPreviousToken() {
    try {
      return sessionStorage.getItem(OWN_LOCK_KEY) || null;
    } catch {
      return null;
    }
  }
  function rememberOwnToken(token) {
    try {
      if (token) sessionStorage.setItem(OWN_LOCK_KEY, token);
      else sessionStorage.removeItem(OWN_LOCK_KEY);
    } catch {
      /* ignore */
    }
  }
  /** 남의 표이면서 아직 살아 있는지. 이 탭이 새로고침 전에 잡았던 표는 내 것으로 본다. */
  function lockIsForeignAndFresh(lock, token) {
    if (!lock || lock.token === token) return false;
    if (lock.token && lock.token === ownPreviousToken()) return false;
    const age = Date.now() - (Date.parse(lock.at || "") || 0);
    return age < REMOTE_LOCK_STALE_MS;
  }
  async function forceClearRemoteLock() {
    try {
      await marinara.storage.patch({ runLock: null });
      rememberOwnToken(null);
      state.remoteLockInfo = null;
      toast("작업 표를 지웠습니다", "success");
      renderStatus();
    } catch (error) {
      toast(`작업 표를 지우지 못했습니다 (${error.message})`, "error");
    }
  }
  /**
   * 확장 저장소에는 원자적 잠금이 없다. "읽기 → 비어 있으면 내 표 쓰기 → 잠시 뒤 다시 읽어 내 표가 남았는지 확인"으로
   * 동시 시작을 거른다. 작업 중에는 60초마다 시각을 갱신해 끊긴 표와 구분한다. 돌려주는 값이 null이면 잡은 것.
   */
  async function claimRemoteLock(run) {
    const token = `${INSTANCE_ID}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const existing = await readRemoteLock();
      if (lockIsForeignAndFresh(existing, token)) {
        state.remoteLockInfo = existing;
        renderStatus();
        const age = Math.round((Date.now() - (Date.parse(existing.at || "") || 0)) / 1000);
        return `다른 탭이나 기기에서 작업 중입니다 (${age}초 전 갱신). 끊긴 작업이면 ${Math.max(0, Math.round(REMOTE_LOCK_STALE_MS / 1000) - age)}초 뒤 자동 해제되고, 상태 줄에서 바로 지울 수도 있습니다`;
      }
      await marinara.storage.patch({ runLock: { token, at: new Date().toISOString(), kind: run.kind } });
      await sleep(700);
      const check = await readRemoteLock();
      if (!check || check.token !== token) return "다른 탭이나 기기에서 같은 순간에 작업을 시작해 이쪽이 물러났습니다. 잠시 뒤 다시 시도하세요";
      run.lockToken = token;
      rememberOwnToken(token);
      run.lockRenew = setInterval(async () => {
        try {
          const current = await readRemoteLock();
          if (current && current.token !== token) {
            clearInterval(run.lockRenew);
            run.lockRenew = null;
            run.lockToken = null;
            if (!run.cancelled) {
              run.cancelled = true;
              toast("다른 탭이나 기기가 작업 표를 가져가 이쪽 작업을 멈췄습니다", "error", 6000);
              renderStatus();
            }
            return;
          }
          await marinara.storage.patch({ runLock: { token, at: new Date().toISOString(), kind: run.kind } });
        } catch {
          /* 다음 갱신 때 다시 */
        }
      }, 60_000);
      return null;
    } catch (error) {
      return `잠금을 기록하지 못했습니다 (${error.message})`;
    }
  }
  async function releaseRemoteLock(run) {
    if (!run.lockToken) return;
    const token = run.lockToken;
    run.lockToken = null;
    if (run.lockRenew) clearInterval(run.lockRenew);
    run.lockRenew = null;
    let cleared = false;
    for (let attempt = 0; attempt < 4 && !cleared; attempt += 1) {
      try {
        const current = await readRemoteLock();
        if (!current || current.token !== token) cleared = true;
        else {
          await marinara.storage.patch({ runLock: null });
          cleared = true;
        }
      } catch (error) {
        log.warn("작업 표 지우기 실패, 다시 시도", attempt + 1, error);
        await sleep(1500 * (attempt + 1));
      }
    }
    if (!cleared) toast("작업 표를 지우지 못했습니다. 3분 뒤 자동 해제되며, 다음 작업이 막히면 상태 줄에서 지울 수 있습니다", "error", 8000);
    rememberOwnToken(null);
  }

  // ── WebP 인코딩 ──
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error || new Error("읽기 실패"));
      fr.readAsDataURL(blob);
    });
  }

  /** 원본(data URL)을 디코딩해 긴 변 상한에 맞춰 줄인 뒤 WebP로 인코딩한다. EXIF 회전은 적용되어 바로 선 그림이 된다. */
  async function encodeWebp(dataUrl, { quality, maxEdge }) {
    const blob = await dataUrlToBlob(dataUrl);
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    try {
      let w = bitmap.width;
      let h = bitmap.height;
      if (maxEdge > 0 && Math.max(w, h) > maxEdge) {
        const scale = maxEdge / Math.max(w, h);
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0, w, h);
      const out = await new Promise((r) => canvas.toBlob(r, "image/webp", clampQuality(quality) / 100));
      if (!out || out.type !== "image/webp") throw new Error("이 브라우저는 WebP 인코딩을 지원하지 않습니다");
      return { blob: out, width: w, height: h };
    } finally {
      bitmap.close?.();
    }
  }

  // ── 사진 자리 찾기 · 고치기 · 확인 ──
  function fpOfAttachment(a) {
    if (!isSentImage(a)) return null;
    const info = dataUrlInfo(a.data);
    return info ? fingerprintOf(a.data, info.bytes) : null;
  }

  /** 사진이 든 자리들을 서버에서 새로 읽는다: 본체(메시지 행 또는 비활성 버전) + 거울 사본(비활성 버전의 같은 사진). */
  async function locateTargets(entry) {
    const row = await fetchMessageRow(entry);
    if (!row) throw new SkipError("메시지를 찾지 못했습니다(지워졌거나 바뀜)");
    let swipes = null;
    const getSwipes = async () => {
      if (!swipes) {
        const got = await api("GET", `/chats/${entry.chatId}/messages/${entry.messageId}/swipes`);
        swipes = Array.isArray(got) ? got : [];
      }
      return swipes;
    };
    const find = (holder) => {
      const atts = parseExtra(holder.extra).attachments;
      const list = Array.isArray(atts) ? atts : [];
      return { list, idx: list.findIndex((a) => fpOfAttachment(a) === entry.fp) };
    };
    const targets = [];
    if (entry.swipeIndex === null || entry.swipeIndex === undefined) {
      const { list, idx } = find(row);
      if (idx < 0) throw new SkipError("사진이 메시지에서 바뀌었거나 지워졌습니다. 다시 읽어 주세요");
      targets.push({ swipeIndex: null, list, idx, att: list[idx] });
    } else {
      const sw = (await getSwipes()).find((x) => x && x.index === entry.swipeIndex);
      if (!sw) throw new SkipError("그 답변 버전이 사라졌습니다. 다시 읽어 주세요");
      const { list, idx } = find(sw);
      if (idx < 0) throw new SkipError("사진이 그 버전에서 바뀌었거나 지워졌습니다. 다시 읽어 주세요");
      targets.push({ swipeIndex: entry.swipeIndex, list, idx, att: list[idx] });
    }
    for (const m of entry.mirrors || []) {
      if (targets.some((t) => t.swipeIndex === m.swipeIndex)) continue;
      const sw = (await getSwipes()).find((x) => x && x.index === m.swipeIndex);
      if (!sw) continue;
      const { list, idx } = find(sw);
      if (idx >= 0) targets.push({ swipeIndex: m.swipeIndex, list, idx, att: list[idx] });
    }
    return { row, targets };
  }

  /** 자리마다 새 첨부 배열을 만들어 PATCH. 메시지 행(swipeIndex null)은 엔진이 활성 버전에도 같이 쓴다. */
  async function patchTargets(entry, targets, makeNext) {
    for (const t of targets) {
      const next = makeNext(t.list, t.idx);
      const qs = t.swipeIndex === null ? "" : `?swipeIndex=${t.swipeIndex}`;
      await api("PATCH", `/chats/${entry.chatId}/messages/${entry.messageId}/extra${qs}`, { attachments: next });
    }
  }

  /** 고친 뒤 서버에서 다시 읽어 자리마다 조건을 확인한다. */
  async function verifyTargets(entry, targets, predicate) {
    const row = await fetchMessageRow(entry);
    if (!row) return false;
    let swipes = null;
    for (const t of targets) {
      let holder = row;
      if (t.swipeIndex !== null) {
        if (!swipes) {
          const got = await api("GET", `/chats/${entry.chatId}/messages/${entry.messageId}/swipes`);
          swipes = Array.isArray(got) ? got : [];
        }
        holder = swipes.find((x) => x && x.index === t.swipeIndex);
        if (!holder) return false;
      }
      const atts = parseExtra(holder.extra).attachments;
      if (!predicate(Array.isArray(atts) ? atts : [])) return false;
    }
    return true;
  }

  /** 한 장을 WebP로 교체. "kept"면 결과가 더 커서 그대로 둔 것. */
  async function convertEntry(entry, options) {
    if (/webp/i.test(entry.type)) throw new SkipError("이미 WebP");
    const { targets } = await locateTargets(entry);
    const enc = await encodeWebp(targets[0].att.data, options);
    if (enc.blob.size >= entry.bytes) return "kept";
    const dataUrl = await blobToDataUrl(enc.blob);
    const info = dataUrlInfo(dataUrl);
    const newFp = fingerprintOf(dataUrl, info.bytes);
    await patchTargets(entry, targets, (list, idx) => list.map((a, i) => (i === idx ? { ...a, type: "image/webp", data: dataUrl } : a)));
    const ok = await verifyTargets(entry, targets, (list) => list.some((a) => fpOfAttachment(a) === newFp));
    if (!ok) throw new Error("교체 뒤 확인에서 새 사진을 찾지 못했습니다");
    const saved = entry.bytes - info.bytes;
    entry.type = "image/webp";
    entry.bytes = info.bytes;
    entry.fp = newFp;
    entry.width = enc.width;
    entry.height = enc.height;
    return { saved };
  }

  /** 한 장을 메시지(와 거울 사본)에서 뺀다. 메시지 자체는 지우지 않는다. */
  async function deleteEntry(entry) {
    const { targets } = await locateTargets(entry);
    await patchTargets(entry, targets, (list, idx) => list.filter((_, i) => i !== idx));
    const ok = await verifyTargets(entry, targets, (list) => !list.some((a) => fpOfAttachment(a) === entry.fp));
    if (!ok) throw new Error("삭제 뒤 확인에서 사진이 아직 남아 있습니다");
    const scan = state.scans.get(entry.chatId);
    if (scan) scan.items = scan.items.filter((e) => e !== entry);
    if (entry.thumb) URL.revokeObjectURL(entry.thumb);
    state.selected.delete(entry.key);
    return { saved: entry.bytes };
  }

  // ── 작업 실행 ──
  async function runJob(entries, kind, options) {
    if (state.run) {
      toast("이미 작업 중입니다", "info");
      return;
    }
    const run = { kind, total: entries.length, done: 0, changed: 0, kept: 0, skipped: 0, failed: 0, saved: 0, cancelled: false, note: null, lockToken: null, lockRenew: null, errors: [] };
    const lockError = await claimRemoteLock(run);
    if (lockError) {
      toast(lockError, "error", 8000);
      return;
    }
    state.remoteLockInfo = null;
    state.run = run;
    scheduleRender();
    const touched = new Set();
    let waitedOnce = false;
    try {
      for (const entry of entries) {
        if (run.cancelled) break;
        try {
          // 열린 방에서 생성 중이면(엔진이 캡션 등을 첨부에 써 넣을 수 있음) 작업당 한 번 최대 60초 기다리고, 계속이면 그 방 사진은 미룬다
          if (entry.chatId === readActiveChatId() && chatIsGenerating()) {
            if (!waitedOnce) {
              waitedOnce = true;
              if (!(await waitForQuiet(run))) throw new SkipError("생성 중이라 미룸");
            } else throw new SkipError("생성 중이라 미룸");
          }
          const r = kind === "delete" ? await deleteEntry(entry) : await convertEntry(entry, options);
          if (r === "kept") run.kept += 1;
          else {
            run.changed += 1;
            run.saved += r.saved || 0;
          }
          touched.add(entry.chatId);
        } catch (error) {
          if (error && error.skip) run.skipped += 1;
          else {
            run.failed += 1;
            log.error(kind, entry.key, error);
          }
          run.errors.push(`${entry.msgNo ? `#${entry.msgNo}` : entry.messageId}: ${error?.message || error}`);
        }
        run.done += 1;
        scheduleRender();
        await nextTick();
      }
    } finally {
      await releaseRemoteLock(run);
      state.run = null;
      state.lastRun = run;
      for (const id of touched) {
        refreshMessages(id);
        const scan = state.scans.get(id);
        if (scan) {
          scan.bytes = scan.items.reduce((a, e) => a + e.bytes, 0);
          void saveRoomStat(id, scan);
        }
      }
      exitSelection({ silent: true });
      scheduleRender();
      const head = kind === "delete" ? "삭제" : "WebP 변환";
      const msg = `${head} ${run.changed}장${run.saved ? ` (−${fmtBytes(run.saved)})` : ""}${run.kept ? ` · 유지 ${run.kept}` : ""}${run.skipped ? ` · 건너뜀 ${run.skipped}` : ""}${run.failed ? ` · 실패 ${run.failed}` : ""}${run.cancelled ? " · 중지됨" : ""}`;
      toast(msg, run.failed ? "error" : "success", run.failed ? 8000 : 5000);
      if (run.errors.length) log.warn("작업 상세", run.errors);
    }
  }

  // ── 대화상자 ──
  function formDialog({ title, html, confirmLabel = "확인", danger = false, setup }) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "sim-overlay";
      overlay.setAttribute("data-chat-floating-panel", "");
      overlay.innerHTML = `
        <div class="sim-dialog" role="dialog" aria-modal="true">
          <h3 class="sim-dialog__title"></h3>
          <div class="sim-dialog__body">${html}</div>
          <div class="sim-dialog__actions">
            <button type="button" class="sim-btn" data-act="cancel">취소</button>
            <button type="button" class="sim-btn sim-btn--primary" data-act="ok"></button>
          </div>
        </div>`;
      overlay.querySelector(".sim-dialog__title").textContent = title;
      const ok = overlay.querySelector('[data-act="ok"]');
      ok.textContent = confirmLabel;
      if (danger) ok.classList.add("sim-btn--danger");
      let dispose = null;
      const done = (value) => {
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
        try {
          dispose?.();
        } catch {
          /* ignore */
        }
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          done(false);
        }
      };
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) done(false);
      });
      overlay.querySelector('[data-act="cancel"]').addEventListener("click", () => done(false));
      ok.addEventListener("click", () => done(true));
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(overlay);
      if (setup) dispose = setup(overlay.querySelector(".sim-dialog__body"), ok) || null;
      ok.focus();
    });
  }

  async function askAndDelete(entries) {
    const bytes = entries.reduce((a, e) => a + e.bytes, 0);
    // 글 없이 사진만 있던 메시지 중, 이번에 사진이 전부 빠지는 메시지 수
    const perMessage = new Map();
    for (const e of entries) {
      if (e.swipeIndex !== null && e.swipeIndex !== undefined) continue;
      const k = `${e.chatId}:${e.messageId}`;
      const cur = perMessage.get(k) || { total: e.attachmentTotal, hasText: e.hasText, n: 0 };
      cur.n += 1;
      perMessage.set(k, cur);
    }
    let emptied = 0;
    for (const v of perMessage.values()) if (!v.hasText && v.n >= v.total) emptied += 1;
    const html = `
      <p class="sim-dialog__message">${entries.length}장 · ${fmtBytes(bytes)}을(를) 메시지에서 뺍니다. <b>되돌릴 수 없습니다.</b>
      메시지 자체와 글, 다른 첨부는 그대로 두고, 숨은 답변 버전에 있는 같은 사진도 함께 뺍니다.${
        emptied ? `\n글 없이 사진만 있던 메시지 ${emptied}개는 글도 사진도 없는 빈 메시지로 남습니다(메시지는 지우지 않습니다).` : ""
      }
      진행 전 백업(설정 → 백업)을 권합니다.</p>`;
    const ok = await formDialog({ title: `사진 ${entries.length}장 삭제`, html, confirmLabel: "삭제", danger: true });
    if (!ok) return;
    await runJob(entries, "delete");
  }

  async function askAndConvert(entries) {
    const candidates = entries.filter((e) => !/webp/i.test(e.type));
    const already = entries.length - candidates.length;
    if (!candidates.length) {
      toast("선택한 사진은 모두 이미 WebP입니다", "info");
      return;
    }
    const bytes = candidates.reduce((a, e) => a + e.bytes, 0);
    const s = state.settings;
    const edgeOptions = EDGE_OPTIONS.map((v) => `<option value="${v}" ${s.maxEdge === v ? "selected" : ""}>${v === 0 ? "제한 없음" : `${v}px`}</option>`).join("");
    const html = `
      <p class="sim-dialog__message">${candidates.length}장 · ${fmtBytes(bytes)}을(를) 브라우저에서 WebP로 다시 인코딩해 메시지 첨부를 교체합니다.${
        already ? ` (이미 WebP인 ${already}장은 건너뜀)` : ""
      }
      파일명·캡션 등 다른 정보는 그대로 두고, 결과가 원본보다 크면 그 장은 그대로 둡니다. 원본은 남지 않으니 진행 전 백업(설정 → 백업)을 권합니다.</p>
      <label class="sim-form__row"><span>품질 <b data-q>${s.quality}</b></span><input type="range" min="${QUALITY_MIN}" max="${QUALITY_MAX}" step="${QUALITY_STEP}" value="${s.quality}" data-act="q"></label>
      <label class="sim-form__row"><span>긴 변 상한</span><select class="sim-select" data-act="edge">${edgeOptions}</select></label>
      <div class="sim-form__note" data-est>예상 계산 중…</div>`;
    let quality = s.quality;
    let maxEdge = s.maxEdge;
    const ok = await formDialog({
      title: `사진 ${candidates.length}장 WebP로 줄이기`,
      html,
      confirmLabel: "줄이기",
      setup(body) {
        const q = body.querySelector('[data-act="q"]');
        const edge = body.querySelector('[data-act="edge"]');
        const est = body.querySelector("[data-est]");
        const qLabel = body.querySelector("[data-q]");
        // 표본 몇 장을 미리 인코딩해 예상치를 보여 준다(원본은 한 번만 받아 둔다)
        const sampleCount = Math.min(6, candidates.length);
        const step = candidates.length / sampleCount;
        const samples = Array.from({ length: sampleCount }, (_, i) => candidates[Math.floor(i * step)]);
        const originals = new Map();
        let token = 0;
        let timer = null;
        const estimate = async () => {
          const my = ++token;
          est.textContent = "예상 계산 중…";
          let before = 0;
          let after = 0;
          let n = 0;
          for (const e of samples) {
            try {
              if (!originals.has(e.key)) originals.set(e.key, (await fetchOriginal(e)).dataUrl);
              const enc = await encodeWebp(originals.get(e.key), { quality, maxEdge });
              before += e.bytes;
              after += Math.min(e.bytes, enc.blob.size);
              n += 1;
            } catch (error) {
              log.warn("예상 계산 실패", e.key, error);
            }
            if (my !== token) return;
          }
          if (!n || !before) {
            est.textContent = "예상치를 계산하지 못했습니다";
            return;
          }
          const ratio = after / before;
          const lines = [`표본 ${n}장: ${fmtBytes(before)} → ${fmtBytes(after)} (${Math.round(ratio * 100)}%) · 전체 예상 약 ${fmtBytes(Math.round(bytes * ratio))}`];
          if (quality >= 100) lines.push("100은 무손실에 가까워 거의 줄지 않습니다.");
          lines.push("보낼 때 엔진이 이미 JPEG(품질 82, 긴 변 1536)로 줄인 사진은 조금만 줄고, PNG는 크게 줄어듭니다.");
          est.textContent = lines.join("\n");
        };
        const schedule = () => {
          clearTimeout(timer);
          timer = setTimeout(estimate, 250);
        };
        q.addEventListener("input", () => {
          quality = clampQuality(q.value);
          qLabel.textContent = String(quality);
          schedule();
        });
        edge.addEventListener("change", () => {
          maxEdge = Number(edge.value) || 0;
          schedule();
        });
        void estimate();
        return () => {
          token += 1;
          clearTimeout(timer);
        };
      },
    });
    if (!ok) return;
    void saveSettings({ quality, maxEdge });
    await runJob(candidates, "convert", { quality, maxEdge });
  }


  // ───────────────────────── 보이는 사진 목록 ─────────────────────────

  function scopeChatIds() {
    if (state.scope === "all") return state.rooms.map((r) => r.id);
    return state.scope ? [state.scope] : [];
  }

  function entriesOf(chatId) {
    return state.scans.get(chatId)?.items || [];
  }

  function sortEntries(list) {
    const dir = state.settings.sort === "oldest" ? 1 : -1;
    return list.slice().sort((a, b) => {
      const ta = Date.parse(a.createdAt) || 0;
      const tb = Date.parse(b.createdAt) || 0;
      if (ta !== tb) return (ta - tb) * dir;
      if ((a.msgNo ?? 0) !== (b.msgNo ?? 0)) return ((a.msgNo ?? 0) - (b.msgNo ?? 0)) * dir;
      return (a.idx - b.idx) * dir;
    });
  }

  function visibleEntries() {
    const out = [];
    for (const chatId of scopeChatIds()) out.push(...entriesOf(chatId));
    return sortEntries(out);
  }

  function entryByKey(key) {
    for (const scan of state.scans.values()) {
      const hit = scan.items.find((e) => e.key === key);
      if (hit) return hit;
    }
    return null;
  }

  // ───────────────────────── 떠 있는 버튼 ─────────────────────────

  function readFabPos() {
    try {
      const v = JSON.parse(localStorage.getItem(FAB_POS_KEY) || "null");
      if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) return v;
    } catch {
      /* ignore */
    }
    return null;
  }
  function writeFabPos(pos) {
    try {
      localStorage.setItem(FAB_POS_KEY, JSON.stringify(pos));
    } catch {
      /* ignore */
    }
  }

  function placeFab() {
    const fab = state.fab;
    if (!fab) return;
    const size = fab.offsetWidth || 36;
    const pos = readFabPos();
    const maxX = window.innerWidth - size - 4;
    const maxY = window.innerHeight - size - 4;
    let x = pos ? pos.x : maxX - 8;
    let y = pos ? pos.y : Math.round(window.innerHeight * 0.42);
    x = Math.min(maxX, Math.max(4, x));
    y = Math.min(maxY, Math.max(4, y));
    fab.style.left = `${x}px`;
    fab.style.top = `${y}px`;
  }

  function makeFab() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mari-window-bubble sim-fab";
    btn.setAttribute("data-sim-fab", "");
    btn.setAttribute("aria-label", EXT_NAME);
    btn.title = EXT_NAME;
    btn.innerHTML =
      '<span class="mari-window-bubble__paint pointer-events-none" aria-hidden="true"></span>' +
      `<span class="mari-window-bubble__icon sim-fab__icon">${SVG.images}</span>`;
    let drag = null;
    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const rect = btn.getBoundingClientRect();
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: rect.left, oy: rect.top, moved: false };
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });
    btn.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      const size = btn.offsetWidth || 36;
      const x = Math.min(window.innerWidth - size - 4, Math.max(4, drag.ox + dx));
      const y = Math.min(window.innerHeight - size - 4, Math.max(4, drag.oy + dy));
      btn.style.left = `${x}px`;
      btn.style.top = `${y}px`;
    });
    const finish = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const wasDrag = drag.moved;
      drag = null;
      try {
        btn.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (wasDrag) {
        writeFabPos({ x: parseFloat(btn.style.left) || 0, y: parseFloat(btn.style.top) || 0 });
      } else if (e.type === "pointerup") {
        void openWindow();
      }
    };
    btn.addEventListener("pointerup", finish);
    btn.addEventListener("pointercancel", finish);
    btn.addEventListener("click", (e) => e.preventDefault());
    document.body.appendChild(btn);
    state.fab = btn;
    placeFab();
    const onResize = () => placeFab();
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
    onCleanup(() => btn.remove());
  }

  function syncFab() {
    if (state.fab) state.fab.style.display = state.win ? "none" : "";
  }

  // ───────────────────────── 창 ─────────────────────────

  async function openWindow() {
    if (state.win) return;
    const win = document.createElement("div");
    win.className = "sim-win";
    win.setAttribute("data-chat-floating-panel", "");
    win.setAttribute("role", "dialog");
    win.setAttribute("aria-label", EXT_NAME);
    win.innerHTML = `
      <div class="sim-head">
        <div class="sim-bar" data-role="bar"></div>
        <div class="sim-status" data-role="status"></div>
      </div>
      <div class="sim-body" data-role="body"></div>`;
    document.body.appendChild(win);
    state.win = win;
    syncFab();
    placeWindow(win);
    attachWindowDrag(win);

    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (state.lightbox) return; // 큰 보기가 먼저 닫힌다
      if (document.querySelector(".sim-overlay")) return;
      e.stopPropagation();
      if (state.selecting) exitSelection();
      else closeWindow();
    };
    document.addEventListener("keydown", onKey, true);
    win._simDispose = () => document.removeEventListener("keydown", onKey, true);

    win.querySelector('[data-role="bar"]').addEventListener("click", onBarClick);
    win.querySelector('[data-role="bar"]').addEventListener("change", onBarChange);
    win.querySelector('[data-role="status"]').addEventListener("click", onBarClick);
    const body = win.querySelector('[data-role="body"]');
    body.addEventListener("click", onBodyClick);
    body.addEventListener("scroll", () => {
      state.gridScrollTop = body.scrollTop;
    });

    renderBar();
    renderStatus();
    body.innerHTML = '<div class="sim-empty">방 목록을 불러오는 중…</div>';
    try {
      await loadSettings();
      await loadRooms();
    } catch (error) {
      body.innerHTML = `<div class="sim-empty">방 목록을 불러오지 못했습니다 (${esc(error.message)})</div>`;
      renderBar();
      return;
    }
    if (!state.win) return;
    if (!state.scope) {
      const active = readActiveChatId();
      state.scope = active && roomById(active) ? active : "all";
    }
    renderBar();
    renderStatus();
    renderGrid();
    if (state.scope !== "all" && !state.scans.has(state.scope)) void startScan([state.scope]);
  }

  function closeWindow() {
    const win = state.win;
    if (!win) return;
    win._simDispose?.();
    win._simDisposeDrag?.();
    win.remove();
    state.win = null;
    state.selecting = false;
    state.selected.clear();
    syncFab();
  }

  // ── 창 위치·크기 (PC) ──

  function isPhoneLayout() {
    return window.matchMedia("(max-width: 767px)").matches;
  }

  function readWinRect() {
    try {
      const v = JSON.parse(localStorage.getItem(WIN_RECT_KEY) || "null");
      if (v && [v.x, v.y, v.w, v.h].every(Number.isFinite)) return v;
    } catch {
      /* ignore */
    }
    return null;
  }
  function writeWinRect(rect) {
    try {
      localStorage.setItem(WIN_RECT_KEY, JSON.stringify(rect));
    } catch {
      /* ignore */
    }
  }

  /** 기억한 위치·크기를 화면 안으로 맞춰 적용한다. 폰에서는 CSS가 전체 화면으로 두므로 손대지 않는다. */
  function placeWindow(win) {
    if (isPhoneLayout()) {
      win.classList.remove("sim-win--placed");
      win.style.left = win.style.top = win.style.width = win.style.height = "";
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const saved = readWinRect();
    let w = saved ? saved.w : Math.min(1040, vw - 32);
    let h = saved ? saved.h : Math.min(Math.round(vh * 0.86), vh - 32);
    w = Math.max(WIN_MIN_W, Math.min(w, vw - 16));
    h = Math.max(WIN_MIN_H, Math.min(h, vh - 16));
    let x = saved ? saved.x : Math.round((vw - w) / 2);
    let y = saved ? saved.y : Math.round((vh - h) / 2);
    x = Math.max(8, Math.min(x, vw - w - 8));
    y = Math.max(8, Math.min(y, vh - h - 8));
    win.classList.add("sim-win--placed");
    win.style.left = `${x}px`;
    win.style.top = `${y}px`;
    win.style.width = `${w}px`;
    win.style.height = `${h}px`;
  }

  function currentWinRect(win) {
    const r = win.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  }

  /** 도구 줄의 빈 곳을 끌어 옮기고, 오른쪽 아래 모서리로 크기를 바꾼다(브라우저 기본 resize 손잡이). 둘 다 기억한다. */
  function attachWindowDrag(win) {
    const head = win.querySelector(".sim-head");
    let drag = null;
    const onDown = (e) => {
      if (e.button !== 0 || isPhoneLayout()) return;
      if (e.target.closest("button, select, input, label, a")) return;
      const r = win.getBoundingClientRect();
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
      try {
        head.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    const onMove = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      const r = win.getBoundingClientRect();
      // 제목 줄이 화면 밖으로 완전히 나가지 않게 한다
      const x = Math.max(-r.width + 120, Math.min(drag.ox + dx, window.innerWidth - 120));
      const y = Math.max(0, Math.min(drag.oy + dy, window.innerHeight - 48));
      win.style.left = `${Math.round(x)}px`;
      win.style.top = `${Math.round(y)}px`;
      e.preventDefault();
    };
    const onUp = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      try {
        head.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (moved) writeWinRect(currentWinRect(win));
    };
    head.addEventListener("pointerdown", onDown);
    head.addEventListener("pointermove", onMove);
    head.addEventListener("pointerup", onUp);
    head.addEventListener("pointercancel", onUp);

    // 크기 조절(브라우저가 width/height 인라인 스타일을 바꾼다) → 멈추면 기억
    let sizeTimer = null;
    const ro = new ResizeObserver(() => {
      if (isPhoneLayout() || drag) return;
      clearTimeout(sizeTimer);
      sizeTimer = setTimeout(() => {
        if (!state.win) return;
        writeWinRect(currentWinRect(win));
      }, 300);
    });
    ro.observe(win);
    const onResize = () => placeWindow(win);
    window.addEventListener("resize", onResize);
    win._simDisposeDrag = () => {
      ro.disconnect();
      clearTimeout(sizeTimer);
      window.removeEventListener("resize", onResize);
    };
  }

  // ── 도구 줄 ──

  function scopeLabel() {
    if (state.scope === "all") return "모든 방";
    return roomName(state.scope);
  }

  function renderBar() {
    const bar = state.win?.querySelector('[data-role="bar"]');
    if (!bar) return;
    const s = state.settings;
    state.win.toggleAttribute("data-selecting", state.selecting);
    if (state.selecting) {
      const picked = Array.from(state.selected).map(entryByKey).filter(Boolean);
      const bytes = picked.reduce((a, e) => a + e.bytes, 0);
      const total = visibleEntries().length;
      bar.innerHTML = `
        <span class="sim-bar__count">${picked.length}장 선택${picked.length ? ` · ${fmtBytes(bytes)}` : ""}</span>
        <button type="button" class="sim-btn sim-btn--small" data-act="select-all">${picked.length >= total && total ? "전체 해제" : "전체 선택"}</button>
        <button type="button" class="sim-btn sim-btn--small" data-act="download-selected" ${picked.length && !state.run ? "" : "disabled"}>${SVG.download}<span>다운로드</span></button>
        <button type="button" class="sim-btn sim-btn--small" data-act="convert-selected" ${picked.length && !state.run ? "" : "disabled"} title="선택한 사진을 WebP로 다시 인코딩해 교체">${SVG.shrink}<span>WebP로 줄이기</span></button>
        <button type="button" class="sim-btn sim-btn--small sim-btn--warn" data-act="delete-selected" ${picked.length && !state.run ? "" : "disabled"}>${SVG.trash}<span>삭제</span></button>
        <span class="sim-spacer"></span>
        <button type="button" class="sim-btn sim-btn--small" data-act="select-off">취소</button>`;
      return;
    }
    const rooms = state.rooms;
    const active = readActiveChatId();
    const options = [`<option value="all" ${state.scope === "all" ? "selected" : ""}>모든 방</option>`];
    for (const r of rooms) {
      const mode = MODE_LABEL[r.mode] || r.mode || "";
      const tag = r.id === active ? " · 지금 방" : "";
      options.push(
        `<option value="${esc(r.id)}" ${state.scope === r.id ? "selected" : ""}>${esc(r.name)}${mode ? ` [${mode}]` : ""}${tag}</option>`,
      );
    }
    const colOptions = COLUMN_OPTIONS.map(
      (c) => `<option value="${c}" ${s.columns === c ? "selected" : ""}>${c === 0 ? "자동" : `${c}열`}</option>`,
    ).join("");
    const reading = !!state.scanRun;
    const unread = state.scope === "all" ? rooms.filter((r) => !state.scans.has(r.id)).length : 0;
    const readLabel = reading ? "읽는 중…" : state.scope === "all" ? (unread ? `안 읽은 방 읽기 (${unread})` : "모두 다시 읽기") : "다시 읽기";
    // 폰에서는 두 줄(위치+닫기 / 나머지)로, PC에서는 한 줄로 흐른다(.sim-bar__g는 PC에서 display: contents)
    bar.innerHTML = `
      <div class="sim-bar__g sim-bar__g--a">
        <span class="sim-bar__title">${SVG.images}<span>보낸 이미지</span></span>
        <label class="sim-field sim-field--scope"><span class="sim-field__label">위치</span>
          <select class="sim-select sim-select--scope" data-act="scope" title="${esc(scopeLabel())}">${options.join("")}</select></label>
        <button type="button" class="sim-icon-btn sim-close--phone" data-act="close" aria-label="닫기" title="닫기">${SVG.x}</button>
      </div>
      <div class="sim-bar__g sim-bar__g--b">
        <label class="sim-field"><span class="sim-field__label">열</span>
          <select class="sim-select" data-act="cols">${colOptions}</select></label>
        <button type="button" class="sim-btn sim-btn--small" data-act="sort" title="정렬 바꾸기">${SVG.sort}<span>${s.sort === "oldest" ? "오래된순" : "최신순"}</span></button>
        <button type="button" class="sim-btn sim-btn--small" data-act="select-on">선택</button>
        <span class="sim-spacer"></span>
        <button type="button" class="sim-btn sim-btn--small" data-act="read" ${reading || state.run ? "disabled" : ""}>${SVG.refresh}<span>${readLabel}</span></button>
        <button type="button" class="sim-icon-btn sim-close--pc" data-act="close" aria-label="닫기" title="닫기">${SVG.x}</button>
      </div>`;
  }

  function renderStatus() {
    const el = state.win?.querySelector('[data-role="status"]');
    if (!el) return;
    const parts = [];
    let action = "";
    const run = state.scanRun;
    if (state.run) {
      const j = state.run;
      const label = j.kind === "delete" ? "삭제하는 중" : "WebP로 줄이는 중";
      parts.push(`${label} ${j.done}/${j.total}${j.saved ? ` · 줄어든 용량 ${fmtBytes(j.saved)}` : ""}${j.kept ? ` · 유지 ${j.kept}` : ""}${j.skipped ? ` · 건너뜀 ${j.skipped}` : ""}${j.failed ? ` · 실패 ${j.failed}` : ""}`);
      if (j.note) parts.push(j.note);
      if (state.note) parts.push(state.note);
      el.innerHTML = `<span class="sim-status__text">${esc(parts.join(" · "))}</span><button type="button" class="sim-btn sim-btn--small" data-act="cancel-run" ${j.cancelled ? "disabled" : ""}>${j.cancelled ? "멈추는 중…" : "중지"}</button>`;
      return;
    }
    if (state.remoteLockInfo) {
      const lock = state.remoteLockInfo;
      const age = Math.round((Date.now() - (Date.parse(lock.at || "") || 0)) / 1000);
      el.innerHTML = `<span class="sim-status__text">${esc(`다른 탭이나 기기의 작업 표가 있습니다 (${lock.kind === "delete" ? "삭제" : "변환"}, ${age}초 전 갱신). 그쪽 작업이 끝난 게 확실할 때만 지우세요`)}</span><button type="button" class="sim-btn sim-btn--small" data-act="clear-lock">표 지우기</button><button type="button" class="sim-icon-btn" data-act="dismiss-lock" aria-label="닫기">${SVG.x}</button>`;
      return;
    }
    if (run && run.current) {
      const scan = state.scans.get(run.current);
      const where = state.scope === "all" ? `${roomName(run.current)} 방 ` : "";
      const pageText = scan ? `${scan.pages}${scan.totalPages ? `/${scan.totalPages}` : ""}페이지` : "";
      const left = state.scope === "all" ? run.chatIds.length - run.chatIds.indexOf(run.current) - 1 : 0;
      parts.push(`${where}읽는 중 ${pageText} · 사진 ${scan ? scan.items.length : 0}장${left > 0 ? ` · 남은 방 ${left}` : ""}`);
      if (state.note) parts.push(state.note);
      action = `<button type="button" class="sim-btn sim-btn--small" data-act="cancel-scan">중지</button>`;
    } else if (state.busy) {
      parts.push(`${state.busy.label} ${state.busy.done}/${state.busy.total}`);
    } else {
      const ids = scopeChatIds();
      const scanned = ids.filter((id) => state.scans.get(id)?.status === "done" || state.scans.get(id)?.status === "cancelled");
      const entries = visibleEntries();
      const bytes = entries.reduce((a, e) => a + e.bytes, 0);
      const byType = {};
      for (const e of entries) byType[typeLabel(e.type)] = (byType[typeLabel(e.type)] || 0) + 1;
      const typeText = Object.entries(byType)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(" · ");
      if (state.scope === "all") {
        const cached = Object.values(state.settings.roomStats || {});
        if (scanned.length) parts.push(`읽은 방 ${scanned.length}/${ids.length} · 사진 ${entries.length}장 · ${fmtBytes(bytes)}${typeText ? ` (${typeText})` : ""}`);
        else if (cached.length) {
          const n = cached.reduce((a, s) => a + (s.n || 0), 0);
          const b = cached.reduce((a, s) => a + (s.b || 0), 0);
          parts.push(`지난번 읽은 기록: ${cached.length}개 방 · 사진 ${n}장 · ${fmtBytes(b)}. 이번에 읽으려면 오른쪽 위 버튼을 누르세요`);
        } else parts.push("아직 읽은 방이 없습니다. 오른쪽 위 버튼으로 모든 방을 읽거나, 위치에서 방을 하나 고르세요");
      } else {
        const scan = state.scans.get(state.scope);
        if (!scan) parts.push("읽기 전");
        else if (scan.status === "error") parts.push(`읽기 실패: ${scan.error}`);
        else {
          parts.push(`사진 ${entries.length}장 · ${fmtBytes(bytes)}${typeText ? ` (${typeText})` : ""} · 메시지 ${scan.messageCount}개${scan.status === "cancelled" ? " · 중간에 멈춤" : ""}`);
        }
      }
    }
    if (!run && !state.busy && state.lastRun) parts.push(runSummary(state.lastRun));
    el.innerHTML = `<span class="sim-status__text">${esc(parts.join(" · "))}</span>${action}`;
  }

  function runSummary(j) {
    const head = j.kind === "delete" ? "삭제" : "변환";
    const bits = [`${head} ${j.changed}장`];
    if (j.saved) bits.push(`−${fmtBytes(j.saved)}`);
    if (j.kept) bits.push(`유지 ${j.kept}`);
    if (j.skipped) bits.push(`건너뜀 ${j.skipped}`);
    if (j.failed) bits.push(`실패 ${j.failed}`);
    if (j.cancelled) bits.push("중지됨");
    return `마지막 작업: ${bits.join(" · ")}`;
  }

  function scheduleRender({ statusOnly = false } = {}) {
    if (!state.win) return;
    if (statusOnly) {
      renderStatus();
      return;
    }
    if (state.renderTimer) return;
    state.renderTimer = setTimeout(() => {
      state.renderTimer = null;
      renderBar();
      renderStatus();
      renderGrid();
    }, 120);
  }

  // ── 그리드 ──

  function tileHtml(entry) {
    const picked = state.selected.has(entry.key);
    const badge = `${typeLabel(entry.type)} ${fmtBytes(entry.bytes)}`;
    const tags = [];
    if (entry.role && entry.role !== "user") tags.push("봇");
    if (entry.swipeIndex !== null && entry.swipeIndex !== undefined) tags.push(`버전 ${entry.swipeIndex + 1}`);
    const roleTag = tags.length ? `<span class="sim-tile__role">${esc(tags.join(" · "))}</span>` : "";
    const img = entry.thumb ? `<img src="${entry.thumb}" alt="" loading="lazy" decoding="async">` : `<span class="sim-tile__broken">미리보기 없음</span>`;
    return `<button type="button" class="sim-tile${picked ? " sim-tile--picked" : ""}" data-key="${esc(entry.key)}" title="${esc(entry.filename || "")}">
      ${img}
      <span class="sim-tile__badge">${esc(badge)}</span>${roleTag}
      <span class="sim-tile__check" aria-hidden="true">${SVG.check}</span>
    </button>`;
  }

  function dateGroupsHtml(entries) {
    const groups = new Map();
    for (const e of entries) {
      const k = dateKey(e.createdAt);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    let html = "";
    for (const [k, list] of groups) {
      html += `<div class="sim-date">${esc(k)} · ${list.length}장</div><div class="sim-grid">${list.map(tileHtml).join("")}</div>`;
    }
    return html;
  }

  function roomHeaderHtml(room, scan) {
    const mode = MODE_LABEL[room.mode] || room.mode || "";
    const stat = state.settings.roomStats?.[room.id];
    let meta = "";
    let action = "";
    const running = state.scanRun?.current === room.id;
    if (running) meta = `읽는 중 ${scan?.pages || 0}${scan?.totalPages ? `/${scan.totalPages}` : ""}페이지`;
    else if (scan && (scan.status === "done" || scan.status === "cancelled")) {
      meta = scan.items.length ? `${scan.items.length}장 · ${fmtBytes(scan.bytes)}` : "사진 없음";
      if (scan.status === "cancelled") meta += " · 중간에 멈춤";
      action = `<button type="button" class="sim-link" data-act="read-room" data-chat="${esc(room.id)}">다시 읽기</button>`;
    } else if (scan && scan.status === "error") {
      meta = `읽기 실패: ${scan.error}`;
      action = `<button type="button" class="sim-link" data-act="read-room" data-chat="${esc(room.id)}">다시 읽기</button>`;
    } else if (stat) {
      meta = `${stat.n}장 · ${fmtBytes(stat.b)} (${fmtAgo(stat.at)} 기준)`;
      action = `<button type="button" class="sim-link" data-act="read-room" data-chat="${esc(room.id)}">읽기</button>`;
    } else {
      meta = "아직 안 읽음";
      action = `<button type="button" class="sim-link" data-act="read-room" data-chat="${esc(room.id)}">읽기</button>`;
    }
    const empty = scan && scan.status === "done" && !scan.items.length;
    return `<div class="sim-room${empty ? " sim-room--empty" : ""}">
      <span class="sim-room__name">${esc(room.name)}</span>${mode ? `<span class="sim-room__mode">${esc(mode)}</span>` : ""}
      <span class="sim-room__meta">${esc(meta)}</span>${action}
    </div>`;
  }

  function renderGrid() {
    const body = state.win?.querySelector('[data-role="body"]');
    if (!body) return;
    const cols = state.settings.columns;
    body.style.setProperty("--sim-cols", cols ? `repeat(${cols}, minmax(0, 1fr))` : "repeat(auto-fill, minmax(9rem, 1fr))");
    let html = "";
    if (state.scope === "all") {
      const active = readActiveChatId();
      const ordered = state.rooms.slice().sort((a, b) => {
        if (a.id === active) return -1;
        if (b.id === active) return 1;
        const sa = state.scans.get(a.id)?.items.length || 0;
        const sb = state.scans.get(b.id)?.items.length || 0;
        if ((sa > 0) !== (sb > 0)) return sa > 0 ? -1 : 1;
        return 0; // 나머지는 서버 순서(최근 수정순)
      });
      for (const room of ordered) {
        const scan = state.scans.get(room.id);
        html += roomHeaderHtml(room, scan);
        if (scan && scan.items.length) html += dateGroupsHtml(sortEntries(scan.items));
      }
      if (!ordered.length) html = '<div class="sim-empty">방이 없습니다</div>';
    } else if (state.scope) {
      const scan = state.scans.get(state.scope);
      const entries = visibleEntries();
      if (entries.length) html = dateGroupsHtml(entries);
      else if (!scan || scan.status === "running") html = '<div class="sim-empty">읽는 중…</div>';
      else if (scan.status === "error") html = `<div class="sim-empty">읽지 못했습니다 (${esc(scan.error)})</div>`;
      else html = '<div class="sim-empty">이 방에는 보낸 이미지가 없습니다</div>';
    }
    const top = state.gridScrollTop;
    body.innerHTML = html;
    body.scrollTop = top;
  }

  // ── 이벤트 ──

  function onBarChange(e) {
    const t = e.target;
    if (!(t instanceof HTMLSelectElement)) return;
    const act = t.getAttribute("data-act");
    if (act === "scope") {
      state.scope = t.value;
      state.gridScrollTop = 0;
      exitSelection({ silent: true });
      renderBar();
      renderStatus();
      renderGrid();
      if (state.scope !== "all" && !state.scans.has(state.scope)) void startScan([state.scope]);
    } else if (act === "cols") {
      void saveSettings({ columns: Number(t.value) || 0 });
      renderGrid();
    }
  }

  async function onBarClick(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    const act = btn.getAttribute("data-act");
    if (act === "close") closeWindow();
    else if (act === "sort") {
      await saveSettings({ sort: state.settings.sort === "oldest" ? "newest" : "oldest" });
      renderBar();
      renderGrid();
    } else if (act === "select-on") {
      state.selecting = true;
      renderBar();
      renderGrid();
    } else if (act === "select-off") exitSelection();
    else if (act === "select-all") {
      const all = visibleEntries();
      if (all.length && all.every((en) => state.selected.has(en.key))) state.selected.clear();
      else for (const en of all) state.selected.add(en.key);
      renderBar();
      renderGrid();
    } else if (act === "download-selected") {
      const picked = visibleEntries().filter((en) => state.selected.has(en.key));
      if (!picked.length) return;
      if (picked.length > 3) {
        const ok = await confirmDialog({
          title: `${picked.length}장 다운로드`,
          message: "여러 파일을 한 번에 받으므로 브라우저가 '여러 파일 다운로드 허용' 여부를 물을 수 있습니다. 허용해 주세요.",
          confirmLabel: "다운로드",
        });
        if (!ok) return;
      }
      await downloadMany(picked);
    } else if (act === "read") {
      if (state.scope === "all") {
        const unread = state.rooms.filter((r) => !state.scans.has(r.id)).map((r) => r.id);
        const ids = unread.length ? unread : state.rooms.map((r) => r.id);
        if (!unread.length) {
          const ok = await confirmDialog({
            title: "모든 방 다시 읽기",
            message: `${ids.length}개 방의 메시지를 처음부터 다시 읽습니다. 큰 방이 많으면 시간이 걸립니다.`,
            confirmLabel: "다시 읽기",
          });
          if (!ok) return;
        }
        void startScan(ids);
      } else if (state.scope) void startScan([state.scope]);
    } else if (act === "cancel-scan") cancelScan();
    else if (act === "cancel-run") {
      if (state.run) {
        state.run.cancelled = true;
        renderStatus();
      }
    } else if (act === "clear-lock") await forceClearRemoteLock();
    else if (act === "dismiss-lock") {
      state.remoteLockInfo = null;
      renderStatus();
    } else if (act === "convert-selected" || act === "delete-selected") {
      const picked = visibleEntries().filter((en) => state.selected.has(en.key));
      if (!picked.length) return;
      if (act === "delete-selected") await askAndDelete(picked);
      else await askAndConvert(picked);
    }
  }

  function exitSelection({ silent = false } = {}) {
    state.selecting = false;
    state.selected.clear();
    if (!silent) {
      renderBar();
      renderGrid();
    }
  }

  function onBodyClick(e) {
    const act = e.target.closest("[data-act]");
    if (act) {
      const a = act.getAttribute("data-act");
      if (a === "read-room") {
        const chatId = act.getAttribute("data-chat");
        if (chatId) void startScan([chatId]);
      }
      return;
    }
    const tile = e.target.closest(".sim-tile");
    if (!tile) return;
    const entry = entryByKey(tile.getAttribute("data-key"));
    if (!entry) return;
    if (state.selecting) {
      if (state.selected.has(entry.key)) state.selected.delete(entry.key);
      else state.selected.add(entry.key);
      tile.classList.toggle("sim-tile--picked", state.selected.has(entry.key));
      renderBar();
      return;
    }
    void openLightbox(entry);
  }

  // ───────────────────────── 큰 보기 ─────────────────────────

  async function openLightbox(entry) {
    closeLightbox();
    const lb = document.createElement("div");
    lb.className = "sim-lb";
    lb.setAttribute("data-chat-floating-panel", "");
    lb.setAttribute("role", "dialog");
    lb.setAttribute("aria-modal", "true");
    lb.innerHTML = `
      <button type="button" class="sim-lb__nav sim-lb__nav--prev" data-act="prev" aria-label="이전">${SVG.prev}</button>
      <div class="sim-lb__stage" data-role="stage"><div class="sim-lb__loading">원본 불러오는 중…</div></div>
      <button type="button" class="sim-lb__nav sim-lb__nav--next" data-act="next" aria-label="다음">${SVG.next}</button>
      <div class="sim-lb__panel">
        <div class="sim-lb__info" data-role="info"></div>
        <div class="sim-lb__actions">
          <button type="button" class="sim-btn sim-btn--small" data-act="jump">${SVG.jump}<span>메시지로 이동</span></button>
          <button type="button" class="sim-btn sim-btn--small" data-act="copy-no">${SVG.copy}<span>번호 복사</span></button>
          <button type="button" class="sim-btn sim-btn--small" data-act="download">${SVG.download}<span>다운로드</span></button>
          <button type="button" class="sim-btn sim-btn--small" data-act="convert-one" title="이 사진을 WebP로 다시 인코딩해 교체">${SVG.shrink}<span>WebP</span></button>
          <button type="button" class="sim-btn sim-btn--small sim-btn--warn" data-act="delete-one">${SVG.trash}<span>삭제</span></button>
          <span class="sim-spacer"></span>
          <button type="button" class="sim-btn sim-btn--small" data-act="close">닫기</button>
        </div>
      </div>`;
    document.body.appendChild(lb);
    state.lightbox = { el: lb, entry, token: 0 };

    const onKey = (e) => {
      if (!state.lightbox) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        closeLightbox();
      } else if (e.key === "ArrowLeft") {
        e.stopPropagation();
        void stepLightbox(-1);
      } else if (e.key === "ArrowRight") {
        e.stopPropagation();
        void stepLightbox(1);
      }
    };
    document.addEventListener("keydown", onKey, true);
    lb._simDispose = () => document.removeEventListener("keydown", onKey, true);
    lb.addEventListener("click", async (e) => {
      if (e.target === lb || e.target.closest('[data-role="stage"]') === e.target) {
        closeLightbox();
        return;
      }
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const cur = state.lightbox?.entry;
      if (!cur) return;
      const act = btn.getAttribute("data-act");
      if (act === "close") closeLightbox();
      else if (act === "prev") void stepLightbox(-1);
      else if (act === "next") void stepLightbox(1);
      else if (act === "jump") void jumpToMessage(cur);
      else if (act === "copy-no") {
        const tag = cur.msgNo ? `#${cur.msgNo}` : "";
        if (!tag) toast("메시지 번호를 모릅니다", "error");
        else toast((await copyText(tag)) ? `${tag} 복사됨 — 그 방의 메시지 검색창에 붙여 넣으면 이동합니다` : "복사하지 못했습니다", "success", 4500);
      } else if (act === "convert-one" || act === "delete-one") {
        if (state.run) {
          toast("이미 작업 중입니다", "info");
          return;
        }
        const target = cur;
        closeLightbox();
        if (act === "delete-one") await askAndDelete([target]);
        else await askAndConvert([target]);
        if (state.win && act === "convert-one" && entryByKey(target.key)) void openLightbox(entryByKey(target.key));
      } else if (act === "download") {
        btn.disabled = true;
        try {
          await downloadEntry(cur);
        } catch (error) {
          toast(error.message, "error", 5000);
        } finally {
          btn.disabled = false;
        }
      }
    });
    await showLightboxEntry(entry);
  }

  function lightboxInfoHtml(entry) {
    const bits = [];
    bits.push(`<strong>${esc(roomName(entry.chatId))}</strong>`);
    if (entry.msgNo) bits.push(`#${entry.msgNo}`);
    if (entry.createdAt) bits.push(esc(fmtDateTime(entry.createdAt)));
    bits.push(`${typeLabel(entry.type)} ${fmtBytes(entry.bytes)}`);
    if (entry.width && entry.height) bits.push(`${entry.width}×${entry.height}`);
    if (entry.filename) bits.push(esc(entry.filename));
    if (entry.role && entry.role !== "user") bits.push("봇 메시지");
    if (entry.swipeIndex !== null && entry.swipeIndex !== undefined) bits.push(`답변 버전 ${entry.swipeIndex + 1} (지금 보이는 버전 아님)`);
    let html = `<div class="sim-lb__line">${bits.join('<span class="sim-dot">·</span>')}</div>`;
    if (entry.caption) html += `<div class="sim-lb__caption">${esc(entry.caption)}</div>`;
    return html;
  }

  async function showLightboxEntry(entry) {
    const lbState = state.lightbox;
    if (!lbState) return;
    lbState.entry = entry;
    lbState.token += 1;
    const token = lbState.token;
    const lb = lbState.el;
    const stage = lb.querySelector('[data-role="stage"]');
    lb.querySelector('[data-role="info"]').innerHTML = lightboxInfoHtml(entry);
    const list = visibleEntries();
    const i = list.findIndex((e) => e.key === entry.key);
    lb.querySelector('[data-act="prev"]').disabled = i <= 0;
    lb.querySelector('[data-act="next"]').disabled = i < 0 || i >= list.length - 1;
    // 썸네일을 먼저 보여 주고 원본이 오면 바꾼다
    stage.innerHTML = entry.thumb
      ? `<img class="sim-lb__img sim-lb__img--thumb" src="${entry.thumb}" alt=""><div class="sim-lb__loading">원본 불러오는 중…</div>`
      : '<div class="sim-lb__loading">원본 불러오는 중…</div>';
    try {
      const { dataUrl } = await fetchOriginal(entry);
      if (!state.lightbox || state.lightbox.token !== token) return;
      stage.innerHTML = `<img class="sim-lb__img" src="${dataUrl}" alt="">`;
    } catch (error) {
      if (!state.lightbox || state.lightbox.token !== token) return;
      const loading = stage.querySelector(".sim-lb__loading");
      if (loading) {
        loading.textContent = error.message;
        loading.classList.add("sim-lb__loading--error");
      }
    }
  }

  async function stepLightbox(dir) {
    const cur = state.lightbox?.entry;
    if (!cur) return;
    const list = visibleEntries();
    const i = list.findIndex((e) => e.key === cur.key);
    const next = list[i + dir];
    if (next) await showLightboxEntry(next);
  }

  function closeLightbox() {
    const lb = state.lightbox;
    if (!lb) return;
    lb.el._simDispose?.();
    lb.el.remove();
    state.lightbox = null;
  }

  // ───────────────────────── 시작·정리 ─────────────────────────

  async function start() {
    await loadSettings();
    makeFab();
    log.info("시작");
  }

  if (typeof marinara.onCleanup === "function") {
    marinara.onCleanup(() => {
      cancelScan();
      if (state.run) state.run.cancelled = true;
      closeLightbox();
      closeWindow();
      for (const scan of state.scans.values()) releaseScan(scan);
      state.scans.clear();
      toastHost?.remove();
      toastHost = null;
      for (const fn of cleanupFns.splice(0)) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
    });
  }

  void start();
})();
