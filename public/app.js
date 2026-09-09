(() => {
  const $ = (s) => document.querySelector(s),
    reader = $("#reader-content"),
    notice = $("#notice");
  let state = null,
    token = null,
    mode = "",
    zoom = 1,
    pages = 1,
    gen = 0,
    sync = 0,
    focused = document.hasFocus() && !document.hidden,
    focusVersion = 0,
    lossVersion = 0,
    verifiedFocusVersion = -1,
    lastFocusLostAt = null;
  let observer = null,
    documentScroll = null,
    activeLoads = 0,
    loadQueue = [];
  const requests = new Set();
  const pageBitmaps = new Map();
  const endedAttempts = new Map();
  const finishingAttempts = new Set();
  const confirmedEnds = new Set();
  const focusEndKey = (id) => `paper-league:focus-end:${id}`;
  const serverTime = () =>
    Math.floor(state ? state.serverNow + performance.now() - sync : Date.now());
  function recordedEnd(id) {
    if (!id) return null;
    if (endedAttempts.has(id)) return endedAttempts.get(id);
    try {
      const raw = localStorage.getItem(focusEndKey(id));
      const at = raw === null ? NaN : Number(raw);
      if (Number.isSafeInteger(at) && at >= 0) {
        endedAttempts.set(id, at);
        return at;
      }
    } catch {}
    return null;
  }
  function recordEnd(attempt, at = lastFocusLostAt ?? serverTime()) {
    const existing = recordedEnd(attempt.id);
    if (existing !== null) return existing;
    const endedAt = Math.max(attempt.startedAt, Math.min(serverTime(), at));
    endedAttempts.set(attempt.id, endedAt);
    try {
      localStorage.setItem(focusEndKey(attempt.id), String(endedAt));
    } catch {}
    return endedAt;
  }
  const hasReaderFocus = () =>
    focused && !document.hidden && document.hasFocus();
  const canShowPaper = () =>
    hasReaderFocus() &&
    verifiedFocusVersion === focusVersion &&
    recordedEnd(state?.attempt?.id) === null;
  const esc = (v) => {
    const d = document.createElement("div");
    d.textContent = v ?? "";
    return d.innerHTML.replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  };
  const msg = (m) => {
    notice.textContent = m;
    notice.classList.add("show");
    setTimeout(() => notice.classList.remove("show"), 4500);
  };
  const time = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  async function api(url, o = {}) {
    const h = {
      Accept: "application/json",
      ...(o.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(state?.csrfToken ? { "X-CSRF-Token": state.csrfToken } : {}),
    };
    const r = await fetch(url, {
      ...o,
      headers: h,
      credentials: "same-origin",
    });
    let d = {};
    try {
      d = await r.json();
    } catch {}
    if (!r.ok) {
      const e = new Error(d.error || `요청 오류 (${r.status})`);
      e.status = r.status;
      throw e;
    }
    return d;
  }
  async function busy(selector, action) {
    const button = $(selector);
    if (!button || button.disabled) return;
    button.disabled = true;
    try {
      await action();
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }
  function clear() {
    observer?.disconnect();
    observer = null;
    documentScroll = null;
    loadQueue = [];
    pageBitmaps.forEach((image) => image.close());
    pageBitmaps.clear();
    document
      .querySelectorAll(".source-canvas,.translation-canvas")
      .forEach((c) => {
        c.width = 0;
        c.height = 0;
        c.style.width = "";
      });
  }
  function stop() {
    gen++;
    requests.forEach((controller) => controller.abort());
    requests.clear();
    activeLoads = 0;
    clear();
  }
  function coverPaper() {
    $("#paper-frame")?.classList.add("concealed");
    const cover = $("#focus-cover");
    if (cover) cover.hidden = false;
  }
  function conceal() {
    focused = false;
    focusVersion++;
    lossVersion++;
    verifiedFocusVersion = -1;
    lastFocusLostAt = serverTime();
    coverPaper();
    stop();
    if (state?.attempt?.phase === "reading") {
      recordEnd(state.attempt);
      mode = "";
      render();
    }
  }
  async function enforceFocusEnd(attempt) {
    const at = recordedEnd(attempt.id);
    if (
      at === null ||
      confirmedEnds.has(attempt.id) ||
      finishingAttempts.has(attempt.id) ||
      !state?.csrfToken
    )
      return;
    finishingAttempts.add(attempt.id);
    try {
      const response = await api("/api/attempt/finish", {
        method: "POST",
        keepalive: true,
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ attemptId: attempt.id, focusLostAt: at }),
      });
      if (response.attempt.phase !== "reading") {
        confirmedEnds.add(attempt.id);
        try {
          localStorage.removeItem(focusEndKey(attempt.id));
        } catch {}
        if (state?.attempt?.id === attempt.id) {
          state.attempt = response.attempt;
          render();
        }
      }
    } catch {
      // Keep the local stop marker until the server confirms the irreversible end.
    } finally {
      finishingAttempts.delete(attempt.id);
    }
  }
  function invite() {
    const p = new URLSearchParams(location.hash.slice(1));
    const t = p.get("access");
    if (t) {
      token = t;
      history.replaceState(
        null,
        "",
        `${location.pathname}${location.search}#reader`,
      );
    }
  }
  function header() {
    const a = $("#account");
    a.replaceChildren();
    if (state?.authenticated) {
      const group = document.createElement("div");
      group.className = "user-chip";
      const name = document.createElement("span");
      name.textContent = state.user?.displayName || "참가자";
      const b = document.createElement("button");
      b.className = "btn secondary";
      b.textContent = "로그아웃";
      b.onclick = async () => {
        try {
          await api("/auth/logout", { method: "POST", body: "{}" });
          state = null;
          token = null;
          await load();
        } catch (e) {
          msg(e.message);
        }
      };
      group.append(name, b);
      a.append(group);
    }
  }
  function render() {
    const current = state?.attempt;
    if (current) {
      if (current.phase === "reading" && !hasReaderFocus()) recordEnd(current);
      if (recordedEnd(current.id) !== null) void enforceFocusEnd(current);
    }
    header();
    const d = $("#demo-banner");
    if (d) d.classList.toggle("hidden", !state?.demo);
    const a = state?.attempt,
      tr = state?.translation,
      k = `${state?.authenticated}-${!!token}-${state?.round?.id || "none"}-${a?.id || "none"}-${a?.phase || "none"}-${recordedEnd(a?.id) !== null}-${confirmedEnds.has(a?.id)}-${tr?.status || "none"}-${tr?.readyPages || 0}-${tr?.totalPages || 0}`;
    if (k !== mode) {
      mode = k;
      stop();
      view();
    }
    tick();
  }
  function view() {
    reader.replaceChildren();
    if (token) {
      reader.innerHTML =
        '<div class="card login-card"><h1>오늘의 논문</h1><button id="claim" class="btn coral">참여하기</button></div>';
      $("#claim").onclick = () => busy("#claim", claim);
      return;
    }
    if (!state?.authenticated) {
      reader.innerHTML = `<div class="card login-card"><h1>논문 읽기</h1><p>Discord에서 <strong>/paper</strong>로 열람 링크를 받아 주세요.</p>${state?.demo ? '<button id="demo" class="btn coral">데모 열기</button>' : ""}</div>`;
      $("#demo")?.addEventListener("click", () => busy("#demo", demo));
      return;
    }
    if (!state.round && !state.attempt) {
      reader.innerHTML = '<div class="empty-state"><h1>논문 준비 중</h1></div>';
      return;
    }
    const a = state.attempt;
    if (!a) {
      const r = state.round;
      const tr = state.translation;
      const translationReady =
        !tr || tr.status === "disabled" || tr.status === "ready";
      const progress =
        tr && tr.status !== "disabled" && tr.status !== "ready"
          ? `<p class="translation-progress">${tr.status === "failed" ? "번역 재시도 대기" : "번역 준비 중"} · ${Number(tr.readyPages) || 0} / ${Number(tr.totalPages) || 0}쪽</p>`
          : "";
      reader.innerHTML = `<div class="card ready-card"><h1>오늘의 논문</h1><p class="lede">읽기 ${Number(r.readingMinutes) || 0}분 · 작성 ${Number(r.writingMinutes) || 0}분</p><p class="rules">이 화면을 벗어나면 열람이 종료되며 다시 볼 수 없습니다.</p>${progress}<button id="start" class="btn coral" ${translationReady ? "" : "disabled"}>읽기 시작</button></div>`;
      $("#start").onclick = () => busy("#start", start);
      return;
    }
    if (
      recordedEnd(a.id) !== null &&
      (a.phase === "reading" || !confirmedEnds.has(a.id))
    ) {
      reader.innerHTML =
        '<div id="focus-ended" class="status-card card"><h1>열람 종료</h1><p>화면을 벗어나 열람이 종료되었습니다. 다시 볼 수 없습니다.</p><p class="muted">연결 복구 후 제출 마감을 확인합니다.</p></div>';
    } else if (a.phase === "reading") reading(a);
    else handoff(a);
  }
  async function claim() {
    try {
      await api("/api/access/redeem", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      token = null;
      await load();
    } catch (e) {
      msg(
        e.status === 401 || e.status === 410
          ? "링크가 만료되었거나 이미 사용되었습니다. Discord에서 /paper로 새 링크를 받아 주세요."
          : e.message,
      );
    }
  }
  async function demo() {
    try {
      await api("/api/demo-login", { method: "POST", body: "{}" });
      await load();
    } catch (e) {
      msg(e.message);
    }
  }
  async function start() {
    const version = lossVersion;
    try {
      const d = await api("/api/attempt/start", { method: "POST", body: "{}" });
      state.attempt = d.attempt;
      if (version !== lossVersion || !hasReaderFocus()) recordEnd(d.attempt);
      mode = "";
      render();
    } catch (e) {
      msg(e.message);
    }
  }
  function reading(a) {
    const translated =
      state.translation && state.translation.status !== "disabled";
    pages = Number(a.pageCount) || 1;
    const translationParts = Array.isArray(state.translation?.parts)
      ? state.translation.parts
      : [];
    const documentGroups = Array.from({ length: pages }, (_, index) => {
      const number = index + 1;
      const source = `<div class="document-group source-group" data-kind="source" data-page="${number}"><div class="page-placeholder">원문 ${number}</div></div>`;
      if (!translated) return source;
      const partCount = Math.max(
        1,
        Math.min(32, Number(translationParts[index]) || 1),
      );
      const sheets = Array.from(
        { length: partCount },
        (_, part) =>
          `<div class="document-group translation-sheet" data-kind="translation" data-page="${number}" data-part="${part + 1}"><div class="page-placeholder">한국어 ${number}-${part + 1}</div></div>`,
      ).join("");
      return `<section class="document-pair"><div class="document-side"><h3>원문 ${number}</h3>${source}</div><div class="document-side translation-side"><h3>한국어 ${number}</h3><div class="translation-stack">${sheets}</div></div></section>`;
    }).join("");
    reader.innerHTML = `<div class="reader-shell"><div class="reading-bar"><h2>${esc(a.paperTitle)}</h2><div class="reader-actions"><strong id="timer" class="timer" aria-label="남은 열람 시간"></strong><div class="reader-zoom"><button id="zoom-out" class="btn secondary" aria-label="페이지 축소">−</button><span id="zoom-level"></span><button id="zoom-in" class="btn secondary" aria-label="페이지 확대">+</button></div><button id="finish" class="btn coral">읽기 종료</button></div></div><div class="paper-frame concealed" id="paper-frame"><div id="paper-document" class="paper-document ${translated ? "paired-document" : "single-document"}">${documentGroups}</div><div id="focus-cover" role="status">불러오는 중…</div></div></div>`;
    $("#zoom-out").onclick = () => {
      zoom = Math.max(1, zoom - 0.25);
      applyZoom();
    };
    $("#zoom-in").onclick = () => {
      zoom = Math.min(2.5, zoom + 0.25);
      applyZoom();
    };
    applyZoom();
    $("#finish").onclick = () => busy("#finish", finish);
    documentScroll = $("#paper-document");
    observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) queueLoad(entry.target);
        });
        releaseDistant();
      },
      { root: documentScroll, rootMargin: "1200px 0px" },
    );
    document
      .querySelectorAll(".document-group[data-kind]")
      .forEach((group) => observer.observe(group));
    documentScroll.addEventListener("scroll", releaseDistant, {
      passive: true,
    });
    queueLoad(document.querySelector('.source-group[data-page="1"]'));
  }
  function queueLoad(group) {
    if (
      !group ||
      group.dataset.loaded === "true" ||
      group.dataset.queued === "true"
    )
      return;
    group.dataset.queued = "true";
    loadQueue.push(group);
    pumpLoads();
  }
  function pumpLoads() {
    while (activeLoads < 2 && loadQueue.length) {
      const group = loadQueue.shift();
      if (!group.isConnected || group.dataset.loaded === "true") continue;
      const generation = gen;
      activeLoads++;
      void loadGroup(group).finally(() => {
        if (generation !== gen) return;
        activeLoads--;
        pumpLoads();
      });
    }
  }
  function validLoad(version) {
    return (
      version === gen &&
      state?.attempt?.phase === "reading" &&
      canShowPaper() &&
      state.attempt.readingEndsAt > serverTime()
    );
  }
  function bitmapKey(group) {
    return `${group.dataset.kind}:${group.dataset.page}:${group.dataset.part || 1}`;
  }
  function draw(group, img, isSource) {
    const canvas = document.createElement("canvas");
    canvas.className = isSource ? "source-canvas" : "translation-canvas";
    if (isSource && group.dataset.page === "1") canvas.id = "paper-canvas";
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext("2d").drawImage(img, 0, 0);
    const sheet = document.createElement("div");
    sheet.className = "document-sheet";
    sheet.append(canvas);
    group.append(sheet);
    pageBitmaps.set(bitmapKey(group), img);
    group.dataset.ratio = String(img.height / Math.max(1, img.width));
  }
  async function loadGroup(group) {
    const version = gen;
    const pageNumber = Number(group.dataset.page);
    const isSource = group.dataset.kind === "source";
    const controller = new AbortController();
    requests.add(controller);
    const images = [];
    try {
      const part = Number(group.dataset.part) || 1;
      if (!validLoad(version)) return;
      const url = isSource
        ? `/api/attempt/page/${pageNumber}`
        : `/api/attempt/translation/${pageNumber}?part=${part}`;
      const response = await fetch(url, {
        signal: controller.signal,
        credentials: "same-origin",
      });
      if (!response.ok)
        throw Object.assign(new Error("페이지를 불러오지 못했습니다."), {
          status: response.status,
        });
      if (!isSource && part === 1) {
        const raw = response.headers.get("X-Page-Parts") || "";
        if (!/^([1-9]|[12][0-9]|3[0-2])$/.test(raw))
          throw Object.assign(
            new Error("번역 페이지 수를 확인하지 못했습니다."),
            { status: 502 },
          );
      }
      const img = await createImageBitmap(await response.blob());
      if (!validLoad(version)) {
        img.close();
        return;
      }
      images.push(img);
      draw(group, img, isSource);
      if (!validLoad(version)) return;
      group.querySelector(".page-placeholder")?.remove();
      group.dataset.loaded = "true";
      delete group.dataset.queued;
      applyZoom();
      if (isSource && pageNumber === 1) {
        $("#paper-frame")?.classList.remove("concealed");
        const cover = $("#focus-cover");
        if (cover) cover.hidden = true;
      }
    } catch (e) {
      if (e.name !== "AbortError" && validLoad(version)) {
        if (e.status === 401 || e.status === 410) await load();
        else {
          group.querySelector(".page-placeholder").textContent =
            "불러오지 못했습니다.";
          msg(e.message);
        }
      }
    } finally {
      requests.delete(controller);
      if (group.dataset.loaded !== "true") {
        images.forEach((img) => {
          if (![...pageBitmaps.values()].includes(img)) img.close();
        });
        group
          .querySelectorAll(".document-sheet")
          .forEach((sheet) => sheet.remove());
        delete group.dataset.queued;
      }
    }
  }
  function releaseDistant() {
    if (!documentScroll) return;
    const root = documentScroll.getBoundingClientRect();
    document
      .querySelectorAll('.document-group[data-kind][data-loaded="true"]')
      .forEach((group) => {
        const rect = group.getBoundingClientRect();
        if (rect.bottom < root.top - 1800 || rect.top > root.bottom + 1800)
          unloadGroup(group);
      });
  }
  function unloadGroup(group) {
    group.querySelectorAll("canvas").forEach((canvas) => {
      canvas.width = 0;
      canvas.height = 0;
    });
    group
      .querySelectorAll(".document-sheet")
      .forEach((sheet) => sheet.remove());
    {
      const key = bitmapKey(group);
      const img = pageBitmaps.get(key);
      if (img) {
        img.close();
        pageBitmaps.delete(key);
      }
    }
    group.insertAdjacentHTML(
      "afterbegin",
      `<div class="page-placeholder">${group.dataset.kind === "source" ? "원문" : "한국어"} ${group.dataset.page}</div>`,
    );
    delete group.dataset.loaded;
  }
  function applyZoom() {
    const contentWidth = Math.max(
      1,
      (documentScroll?.clientWidth || 1068) - 28,
    );
    const pairedWidth = Math.max(520, Math.floor((contentWidth - 14) / 2));
    document.querySelectorAll(".document-pair").forEach((pair) => {
      const width = Math.round(pairedWidth * zoom);
      pair.style.gridTemplateColumns = `${width}px ${width}px`;
    });
    const single = $(".single-document");
    if (single)
      single.style.gridTemplateColumns = `${Math.max(520, Math.round(contentWidth * zoom))}px`;
    document.querySelectorAll(".document-group[data-kind]").forEach((group) => {
      const width = group.clientWidth;
      const ratio = Number(group.dataset.ratio) || 1.42;
      group.style.minHeight = `${Math.max(360, Math.floor(width * ratio))}px`;
      group.querySelectorAll("canvas").forEach((canvas) => {
        if (canvas.width > 0)
          canvas.style.width = `${Math.max(1, Math.floor(width))}px`;
      });
    });
    if ($("#zoom-level"))
      $("#zoom-level").textContent = `${Math.round(zoom * 100)}%`;
    if ($("#zoom-out")) $("#zoom-out").disabled = zoom <= 1;
    if ($("#zoom-in")) $("#zoom-in").disabled = zoom >= 2.5;
  }
  window.addEventListener("resize", applyZoom);
  async function finish() {
    try {
      const d = await api("/api/attempt/finish", {
        method: "POST",
        body: JSON.stringify({ attemptId: state.attempt.id }),
      });
      stop();
      state.attempt = d.attempt;
      mode = "";
      render();
    } catch (e) {
      msg(e.message);
    }
  }
  function handoff(a) {
    const left = a.submitBy - (state.serverNow + (performance.now() - sync));
    const expired = left <= 0,
      done = ["queued", "grading", "graded", "failed"].includes(a.phase);
    reader.innerHTML = `<div id="discord-handoff" class="status-card card"><h1>${expired && !done ? "제출 마감" : "열람 종료"}</h1>${done ? "<p>Discord <strong>/my-score</strong>에서 결과를 확인해 주세요.</p>" : expired ? "" : '<p>Discord <strong>/submit</strong>으로 제출해 주세요.</p><strong id="timer" class="timer"></strong>'}</div>`;
  }
  function tick() {
    if (focused && (!document.hasFocus() || document.hidden)) conceal();
    const el = $("#timer"),
      a = state?.attempt;
    if (!el || !a) return;
    const end = a.phase === "reading" ? a.readingEndsAt : a.submitBy,
      left = end - (state.serverNow + (performance.now() - sync));
    el.textContent =
      a.phase === "reading"
        ? time(left)
        : left <= 0
          ? "00:00"
          : `제출까지 ${time(left)}`;
    if (left <= 0 && a.phase === "reading") expire();
    else if (left <= 0 && a.phase === "writing") {
      state.attempt = { ...a, phase: "expired" };
      mode = "";
      render();
    }
  }
  function expire() {
    if (state?.attempt?.phase !== "reading") return;
    stop();
    state.attempt = { ...state.attempt, phase: "writing" };
    mode = "";
    render();
    load();
  }
  async function load() {
    const version = focusVersion;
    const loss = lossVersion;
    try {
      const next = await api("/api/state");
      if (next.attempt?.phase === "reading" && loss !== lossVersion)
        recordEnd(next.attempt);
      state = next;
      sync = performance.now();
      if (hasReaderFocus()) verifiedFocusVersion = version;
      render();
    } catch (e) {
      if (!state)
        reader.innerHTML =
          '<div class="empty-state"><h1>Paper League를 불러오는 중입니다.</h1><p>잠시 후 다시 시도해 주세요.</p></div>';
      msg(
        navigator.onLine
          ? "서버와 통신할 수 없습니다."
          : "오프라인 상태입니다. 타이머는 계속 흐릅니다.",
      );
    }
  }
  async function restore() {
    if (document.hidden || !document.hasFocus()) return;
    if (!focused) {
      focused = true;
      focusVersion++;
    }
    await load();
  }
  invite();
  load();
  setInterval(load, 4000);
  setInterval(tick, 250);
  window.addEventListener("blur", conceal);
  window.addEventListener("focus", restore);
  window.addEventListener("pagehide", conceal);
  window.addEventListener("pageshow", restore);
  window.addEventListener("online", () => load());
  window.addEventListener("storage", (event) => {
    if (
      state?.attempt?.phase === "reading" &&
      event.key === focusEndKey(state.attempt.id) &&
      event.newValue !== null
    ) {
      coverPaper();
      stop();
      mode = "";
      render();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) conceal();
    else restore();
  });
  ["contextmenu", "dragstart", "copy", "cut"].forEach((type) =>
    document.addEventListener(type, (e) => {
      if (
        e.target instanceof Element &&
        e.target.closest("#paper-canvas,.paper-frame")
      )
        e.preventDefault();
    }),
  );
})();
