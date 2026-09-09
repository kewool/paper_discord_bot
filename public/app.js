(() => {
  const $ = (s) => document.querySelector(s),
    reader = $("#reader-content"),
    notice = $("#notice");
  let state = null,
    token = null,
    mode = "",
    page = 1,
    pages = 1,
    bitmap = null,
    req = null,
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
  }
  function stop() {
    gen++;
    req?.abort();
    req = null;
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
      b.textContent = "웹 세션 종료";
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
      k = `${state?.authenticated}-${!!token}-${state?.round?.id || "none"}-${a?.id || "none"}-${a?.phase || "none"}-${recordedEnd(a?.id) !== null}-${confirmedEnds.has(a?.id)}`;
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
        '<div class="card login-card"><div class="eyebrow">PRIVATE INVITATION</div><h3>오늘의 리딩 링크가 도착했습니다.</h3><p>개인 초대 링크를 확인하고 리그에 참여해 주세요.</p><button id="claim" class="btn coral">이 링크로 참여하기</button></div>';
      $("#claim").onclick = () => busy("#claim", claim);
      return;
    }
    if (!state?.authenticated) {
      reader.innerHTML = `<div class="hero"><div><div class="eyebrow">READ ONLY · PAPER LEAGUE</div><h1>오늘 읽은 한 편이<br>내일의 질문이 됩니다.</h1><p class="lede">디스코드에서 <strong>/paper</strong> 명령어를 사용하면 개인 열람 링크를 받을 수 있습니다.</p></div><div class="card login-card"><h3>Discord에서 참여 링크를 받아 주세요.</h3><p>웹에서는 논문을 읽고, 정리 제출과 결과 확인은 Discord에서 진행합니다.</p>${state?.demo ? '<button id="demo" class="btn coral">데모로 열람하기</button>' : ""}</div></div>`;
      $("#demo")?.addEventListener("click", () => busy("#demo", demo));
      return;
    }
    if (!state.round && !state.attempt) {
      reader.innerHTML =
        '<div class="empty-state"><h1>오늘의 논문을 준비 중입니다.</h1><p>운영자가 라운드를 가져오면 열람할 수 있습니다.</p></div>';
      return;
    }
    const a = state.attempt;
    if (!a) {
      const r = state.round;
      reader.innerHTML = `<div class="hero"><div><div class="eyebrow">${esc(r.day || "TODAY")} · READING</div><h1>오늘의 연구를<br>천천히 읽어보세요.</h1><p class="lede">읽기 시작 버튼을 누르면 ${Number(r.readingMinutes) || 0}분의 열람 시간이 시작됩니다.</p><div class="rules">다른 창이나 탭으로 이동하거나 이 페이지를 떠나면 남은 열람 시간이 즉시 종료됩니다. 다시 열 수 없으니 읽기에 집중할 수 있을 때 시작해 주세요.</div><br><button id="start" class="btn coral">읽기 시작하기 →</button></div><div class="card round-card"><h3>읽기 전 안내</h3><p class="muted">웹은 읽기만 제공합니다. 정리는 Discord의 <strong>/submit</strong> 명령어로 제출해 주세요.</p></div></div>`;
      $("#start").onclick = () => busy("#start", start);
      return;
    }
    if (
      recordedEnd(a.id) !== null &&
      (a.phase === "reading" || !confirmedEnds.has(a.id))
    ) {
      reader.innerHTML =
        '<div id="focus-ended" class="status-card card"><div class="eyebrow">READING ENDED</div><h1>포커스를 벗어나 열람이 종료되었습니다.</h1><p class="lede">남은 열람 시간은 종료되었으며 이 논문을 다시 열 수 없습니다.</p><p>서버에 종료 시각을 전달하고 있습니다. 연결이 복구되면 디스코드 제출 마감을 확인합니다.</p></div>';
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
    reader.innerHTML = `<div class="reader-shell"><div class="eyebrow">NOW READING · ${esc(a.paperTitle)}</div><div class="reading-bar"><h2>${esc(a.paperTitle)}</h2><strong id="timer" class="timer"></strong></div><div class="paper-frame concealed" id="paper-frame"><canvas id="paper-canvas"></canvas><div id="loading" class="muted">페이지를 불러오는 중입니다…</div><div id="focus-cover" role="status"><h3>열람 상태를 확인하고 있습니다.</h3><p>포커스를 벗어나면 열람이 즉시 종료되며 다시 열 수 없습니다.</p></div></div><div class="reader-controls"><button id="prev" class="btn secondary">← 이전</button><span id="count" class="page-count"></span><button id="next" class="btn secondary">다음 →</button><button id="finish" class="btn coral">읽기 종료하기</button></div></div>`;
    pages = Number(a.pageCount) || 1;
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
    try {
      const r = await fetch(`/api/attempt/page/${page}`, {
        signal: req.signal,
        credentials: "same-origin",
      });
      if (!r.ok)
        throw Object.assign(new Error("페이지를 불러오지 못했습니다."), {
          status: r.status,
        });
      const img = await createImageBitmap(await r.blob());
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
      $("#paper-frame").classList.remove("concealed");
      $("#focus-cover").hidden = true;
      $("#loading").classList.add("hidden");
      $("#count").textContent = `${page} / ${pages}`;
      $("#prev").disabled = page <= 1;
      $("#next").disabled = page >= pages;
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
  function change(d) {
    page = Math.max(1, Math.min(pages, page + d));
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
    reader.innerHTML = `<div id="discord-handoff" class="status-card card"><div class="eyebrow">READING COMPLETE</div><h1>${done ? "열람이 종료되었습니다." : expired ? "제출 마감이 지났습니다." : "디스코드에서 정리를 제출해 주세요."}</h1><p class="lede">${done ? "제출 상태와 결과는 디스코드 /my-score에서 확인해 주세요." : expired ? "제출 마감 시간이 지났습니다." : "Discord의 <strong>/submit</strong> 명령어로 정리를 제출해 주세요."}</p>${done ? "" : '<strong id="timer" class="timer"></strong>'}${discordUrl ? '<br><br><a class="btn coral" target="_blank" rel="noopener noreferrer" href="' + esc(discordUrl) + '">디스코드로 돌아가기 ↗</a>' : '<p class="muted">로컬 데모는 열람만 체험합니다. 실제 제출은 운영 Discord에서 진행해 주세요.</p>'}</div>`;
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
