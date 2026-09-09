(() => {
  const $ = (s) => document.querySelector(s),
    reader = $("#reader-content"),
    notice = $("#notice");
  let state = null,
    token = null,
    mode = "",
    page = 1,
    zoom = 1,
    pages = 1,
    bitmap = null,
    translationBitmaps = [],
    req = null,
    translationReq = null,
    gen = 0,
    sync = 0,
    focused = document.hasFocus() && !document.hidden,
    focusVersion = 0,
    lossVersion = 0,
    verifiedFocusVersion = -1,
    lastFocusLostAt = null;
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
    const c = $("#paper-canvas");
    if (c) {
      c.width = 0;
      c.height = 0;
      c.style.width = "";
    }
    bitmap?.close();
    bitmap = null;
    translationBitmaps.forEach((image) => image?.close());
    translationBitmaps = [];
    document.querySelectorAll(".translation-canvas").forEach((c) => {
      c.width = 0;
      c.height = 0;
      c.style.width = "";
    });
  }
  function stop() {
    gen++;
    req?.abort();
    req = null;
    translationReq?.abort();
    translationReq = null;
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
      page = 1;
      render();
    } catch (e) {
      msg(e.message);
    }
  }
  function reading(a) {
    const translated =
      state.translation && state.translation.status !== "disabled";
    reader.innerHTML = `<div class="reader-shell"><div class="reading-bar"><h2>${esc(a.paperTitle)}</h2><strong id="timer" class="timer" aria-label="남은 열람 시간"></strong></div><div class="paper-frame concealed" id="paper-frame"><div class="paper-columns"><section class="paper-panel"><h3>원문</h3><div class="paper-surface" id="paper-surface"><canvas id="paper-canvas"></canvas><div id="loading" class="muted">불러오는 중…</div></div></section>${translated ? '<section class="paper-panel translation-panel"><h3>한국어</h3><div id="translation-pages" class="translation-pages"></div><div id="translation-status" class="muted">불러오는 중…</div></section>' : ""}</div><div id="focus-cover" role="status">불러오는 중…</div></div><div class="reader-controls"><button id="prev" class="btn secondary">← 이전</button><span id="count" class="page-count"></span><button id="next" class="btn secondary">다음 →</button><button id="finish" class="btn coral">읽기 종료</button></div></div>`;
    pages = Number(a.pageCount) || 1;
    const zoomControls = document.createElement("div");
    zoomControls.className = "reader-zoom";
    zoomControls.innerHTML =
      '<button id="zoom-out" class="btn secondary" aria-label="페이지 축소">−</button><span id="zoom-level"></span><button id="zoom-in" class="btn secondary" aria-label="페이지 확대">+</button>';
    $(".reader-controls").prepend(zoomControls);
    $("#zoom-out").onclick = () => {
      zoom = Math.max(1, zoom - 0.25);
      applyZoom();
    };
    $("#zoom-in").onclick = () => {
      zoom = Math.min(2.5, zoom + 0.25);
      applyZoom();
    };
    applyZoom();
    $("#prev").onclick = () => change(-1);
    $("#next").onclick = () => change(1);
    $("#finish").onclick = () => busy("#finish", finish);
    loadPage();
  }
  async function loadPage() {
    if (state?.attempt?.phase !== "reading" || !canShowPaper()) return;
    const g = ++gen;
    req?.abort();
    req = new AbortController();
    translationReq?.abort();
    translationReq = new AbortController();
    const translationController = translationReq;
    const translationEnabled =
      state.translation && state.translation.status !== "disabled";
    if (translationEnabled) {
      const status = $("#translation-status");
      if (status) {
        status.textContent = "불러오는 중…";
        status.classList.remove("hidden");
      }
    }
    try {
      const originalResponse = await fetch(`/api/attempt/page/${page}`, {
        signal: req.signal,
        credentials: "same-origin",
      });
      if (!originalResponse.ok)
        throw Object.assign(new Error("페이지를 불러오지 못했습니다."), {
          status: originalResponse.status,
        });
      const img = await createImageBitmap(await originalResponse.blob());
      if (g !== gen || !canShowPaper()) {
        img.close();
        return;
      }
      const a = state?.attempt;
      if (g !== gen || !a || a.phase !== "reading" || !canShowPaper()) {
        img.close();
        return;
      }
      const left =
        a.readingEndsAt - (state.serverNow + (performance.now() - sync));
      if (left <= 0) {
        img.close();
        expire();
        return;
      }
      clear();
      bitmap = img;
      const c = $("#paper-canvas");
      if (!c) {
        clear();
        return;
      }
      c.width = img.width;
      c.height = img.height;
      c.style.width = `${img.width}px`;
      c.getContext("2d").drawImage(img, 0, 0);
      applyZoom();
      $("#paper-frame").classList.remove("concealed");
      $("#focus-cover").hidden = true;
      $("#loading").classList.add("hidden");
      $("#count").textContent = `${page} / ${pages}`;
      $("#prev").disabled = page <= 1;
      $("#next").disabled = page >= pages;
      if (translationEnabled)
        void loadTranslations(g, page, translationController);
    } catch (e) {
      if (e.name === "AbortError") return;
      if (e.status === 401 || e.status === 410) {
        clear();
        await load();
      } else msg(e.message);
    } finally {
      if (g === gen) req = null;
    }
  }
  async function loadTranslations(g, requestedPage, controller) {
    const tr = state?.translation;
    if (!tr || tr.status === "disabled" || tr.status !== "ready") return;
    let total = 1;
    const canvases = [],
      images = [];
    let committed = false;
    try {
      for (let part = 1; part <= total; part++) {
        if (g !== gen || requestedPage !== page || !canShowPaper()) return;
        const current = state?.attempt;
        if (!current || current.readingEndsAt - serverTime() <= 0) {
          expire();
          return;
        }
        const r = await fetch(
          `/api/attempt/translation/${requestedPage}?part=${part}`,
          { signal: controller.signal, credentials: "same-origin" },
        );
        if (!r.ok)
          throw Object.assign(new Error("번역을 불러오지 못했습니다."), {
            status: r.status,
          });
        if (part === 1) {
          const rawParts = r.headers.get("X-Page-Parts") || "";
          const parsedParts = Number(rawParts);
          if (
            !/^([1-9]|[12][0-9]|3[0-2])$/.test(rawParts) ||
            !Number.isInteger(parsedParts)
          )
            throw Object.assign(
              new Error("번역 페이지 수를 확인하지 못했습니다."),
              { status: 502 },
            );
          total = parsedParts;
        }
        const img = await createImageBitmap(await r.blob());
        if (g !== gen || requestedPage !== page || !canShowPaper()) {
          img.close();
          return;
        }
        if (
          !state?.attempt ||
          state.attempt.readingEndsAt - serverTime() <= 0
        ) {
          img.close();
          expire();
          return;
        }
        const c = document.createElement("canvas");
        c.className = "translation-canvas";
        c.width = img.width;
        c.height = img.height;
        c.style.width = `${img.width}px`;
        c.getContext("2d").drawImage(img, 0, 0);
        canvases.push(c);
        images.push(img);
      }
      const host = $("#translation-pages");
      if (!host || g !== gen || requestedPage !== page || !canShowPaper())
        return;
      host.replaceChildren(...canvases);
      applyZoom();
      translationBitmaps = images;
      committed = true;
      host.scrollTop = 0;
      $("#translation-status")?.classList.add("hidden");
    } catch (e) {
      canvases.forEach((c) => {
        c.width = 0;
        c.height = 0;
        c.remove();
      });
      if (e.name === "AbortError") return;
      if (e.status === 401 || e.status === 410) {
        clear();
        await load();
        return;
      }
      const status = $("#translation-status");
      if (status && g === gen) {
        status.textContent =
          e.status === 409 || e.status === 503
            ? "번역을 준비하지 못했습니다."
            : "번역을 불러오지 못했습니다.";
        status.classList.remove("hidden");
        const retry = document.createElement("button");
        retry.className = "btn secondary translation-retry";
        retry.textContent = "다시 시도";
        retry.onclick = () => loadPage();
        status.append(" ", retry);
      }
    } finally {
      if (!committed) {
        images.forEach((image) => image.close());
        canvases.forEach((c) => {
          c.width = 0;
          c.height = 0;
          c.remove();
        });
      }
      if (g === gen && translationReq === controller) translationReq = null;
    }
  }
  function applyZoom() {
    for (const host of document.querySelectorAll(
      "#paper-surface,#translation-pages",
    )) {
      const style = getComputedStyle(host);
      const width =
        host.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight);
      for (const canvas of host.querySelectorAll("canvas"))
        if (canvas.width > 0)
          canvas.style.width = `${Math.max(1, Math.floor(width * zoom))}px`;
    }
    if ($("#zoom-level"))
      $("#zoom-level").textContent = `${Math.round(zoom * 100)}%`;
    if ($("#zoom-out")) $("#zoom-out").disabled = zoom <= 1;
    if ($("#zoom-in")) $("#zoom-in").disabled = zoom >= 2.5;
  }
  window.addEventListener("resize", applyZoom);
  function change(d) {
    page = Math.max(1, Math.min(pages, page + d));
    stop();
    $("#paper-frame")?.classList.add("concealed");
    $("#translation-status")?.classList.remove("hidden");
    $("#translation-pages")?.replaceChildren();
    if ($("#translation-pages")) $("#translation-pages").scrollTop = 0;
    if ($("#paper-surface")) $("#paper-surface").scrollTop = 0;
    $("#loading")?.classList.remove("hidden");
    $("#prev")?.toggleAttribute("disabled", page <= 1);
    $("#next")?.toggleAttribute("disabled", page >= pages);
    loadPage();
  }
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
    const discordUrl = /^https:\/\/discord\.com\/channels\/\d+\/\d+$/.test(
      state.discordUrl || "",
    )
      ? state.discordUrl
      : null;
    reader.innerHTML = `<div id="discord-handoff" class="status-card card"><h1>${expired && !done ? "제출 마감" : "열람 종료"}</h1>${done ? "<p>Discord <strong>/my-score</strong>에서 결과를 확인해 주세요.</p>" : expired ? "" : '<p>Discord <strong>/submit</strong>으로 제출해 주세요.</p><strong id="timer" class="timer"></strong>'}${discordUrl ? '<br><br><a class="btn coral" target="_blank" rel="noopener noreferrer" href="' + esc(discordUrl) + '">디스코드로 돌아가기 ↗</a>' : ""}</div>`;
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
    clear();
    req?.abort();
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
      if (
        state.attempt?.phase === "reading" &&
        canShowPaper() &&
        !bitmap &&
        !req
      )
        void loadPage();
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
