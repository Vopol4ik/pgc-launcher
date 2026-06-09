'use strict';

const state = {
  data: null,
  logTab: 'launcher',
  authed: false,
  configured: false
};

function $(id) {
  return document.getElementById(id);
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ru-RU');
  } catch {
    return String(iso);
  }
}

function shortHwid(hwid) {
  const s = String(hwid || '');
  if (s.length <= 12) return s || '—';
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

async function api(path, options) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { Accept: 'application/json', ...(options?.headers || {}) },
    ...options
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function showAuth(mode) {
  $('auth-screen').hidden = false;
  $('app-shell').hidden = true;
  const desc = $('auth-desc');
  const submit = $('auth-submit');
  if (mode === 'setup') {
    desc.textContent = 'Задайте пароль администратора (минимум 8 символов). Он хранится только на этом ПК.';
    submit.textContent = 'Создать пароль';
  } else {
    desc.textContent = 'Вход только для администратора проекта.';
    submit.textContent = 'Войти';
  }
  $('auth-error').hidden = true;
}

function showApp() {
  $('auth-screen').hidden = true;
  $('app-shell').hidden = false;
  state.authed = true;
}

function setView(name) {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.view === name);
  });
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('is-active', view.id === `view-${name}`);
  });
}

async function sendClientCommand(hwid, type, payload = {}) {
  await api('/api/clients/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hwid, type, payload })
  });
}

function bindClientActions() {
  document.querySelectorAll('[data-cmd]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const hwid = btn.dataset.hwid;
      const type = btn.dataset.cmd;
      try {
        if (type === 'message') {
          const text = prompt('Текст сообщения игроку:');
          if (!text) return;
          await sendClientCommand(hwid, type, { text });
        } else if (type === 'ban-hwid') {
          const reason = prompt('Причина бана HWID:', 'Нарушение правил') || 'Нарушение правил';
          await api('/api/bans', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hwid, reason, by: 'Админ-панель', permanent: true })
          });
        } else {
          await sendClientCommand(hwid, type, {});
        }
        await refreshClients();
        alert('Команда отправлена');
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

function renderClients(clients) {
  const rows = clients || [];
  $('clients-body').innerHTML = rows.length
    ? rows.map((c) => `
      <tr>
        <td><strong>${c.username || '—'}</strong></td>
        <td><code title="${c.hwid}">${shortHwid(c.hwid)}</code></td>
        <td>${c.launcherVersion || '—'}</td>
        <td><span class="badge ${c.gameRunning ? 'active' : 'inactive'}">${c.gameRunning ? 'В игре' : 'Лаунчер'}</span></td>
        <td>${c.ip || '—'}</td>
        <td>${fmtDate(c.lastSeen)}</td>
        <td class="actions-cell">
          <button class="btn-ghost" type="button" data-cmd="message" data-hwid="${c.hwid}">Сообщение</button>
          <button class="btn-ghost" type="button" data-cmd="stop-game" data-hwid="${c.hwid}">Стоп игра</button>
          <button class="btn-ghost warn" type="button" data-cmd="close-launcher" data-hwid="${c.hwid}">Закрыть</button>
          <button class="btn-ghost bad" type="button" data-cmd="ban-hwid" data-hwid="${c.hwid}">Бан HWID</button>
        </td>
      </tr>
    `).join('')
    : '<tr><td colspan="7" class="muted">Нет онлайн-клиентов</td></tr>';
  bindClientActions();
}

function renderDashboard(d) {
  const srv = d.serverStatus || {};
  const online = d.clients?.online?.length ?? 0;
  const cards = [
    { label: 'Версия лаунчера', value: d.appVersion || '—' },
    { label: 'Minecraft', value: `${d.minecraft?.version || '—'} · Forge ${d.minecraft?.forgeVersion || '—'}` },
    { label: 'Онлайн сервера', value: srv.online ? String(srv.playersOnline ?? 0) : 'офлайн', cls: srv.online ? 'ok' : 'bad' },
    { label: 'Онлайн лаунчеров', value: String(online), cls: online ? 'ok' : '' },
    { label: 'Активных банов', value: String(d.bans?.count ?? 0), cls: d.bans?.count ? 'warn' : '' },
    { label: 'Пинг', value: srv.pingMs != null ? `${srv.pingMs} ms` : '—' }
  ];

  $('dash-cards').innerHTML = cards.map((c) => `
    <article class="stat-card">
      <div class="stat-label">${c.label}</div>
      <div class="stat-value ${c.cls || ''}">${c.value}</div>
    </article>
  `).join('');

  $('dash-server').innerHTML = srv.online
    ? `<div><strong>${d.server}</strong></div>
       <div style="margin-top:8px">Игроки: ${srv.playersOnline ?? 0} / ${srv.playersMax ?? '?'}</div>
       <div>Пинг: ${srv.pingMs ?? '—'} ms</div>`
    : `<span style="color:var(--danger)">Сервер недоступен</span>${srv.error ? `<div style="margin-top:8px">${srv.error}</div>` : ''}`;

  const list = (d.clients?.online || []).slice(0, 8);
  $('dash-clients').textContent = list.length
    ? list.map((c) => `${c.username || '?'} · ${shortHwid(c.hwid)} · ${c.gameRunning ? 'игра' : 'лаунчер'} · ${fmtDate(c.lastSeen)}`).join('\n')
    : 'Подключённых лаунчеров нет.';

  const pill = $('panel-status');
  pill.textContent = srv.online ? 'Сервер онлайн' : 'Сервер офлайн';
  pill.className = `pill ${srv.online ? 'is-online' : 'is-offline'}`;

  renderClients(d.clients?.online || []);
}

function renderPlayers(d) {
  const rows = d.players || [];
  $('players-body').innerHTML = rows.length
    ? rows.map((p) => `
      <tr>
        <td><strong>${p.name}</strong></td>
        <td>${p.launches || 0}</td>
        <td>${fmtDate(p.lastSeen)}</td>
        <td>${p.lastEvent || '—'}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="4" class="muted">Нет данных</td></tr>';
}

function renderBans(d) {
  const rows = d.bans?.all || [];
  $('bans-body').innerHTML = rows.length
    ? rows.map((b) => `
      <tr>
        <td><strong>${b.player || '—'}</strong></td>
        <td><code title="${b.hwid || ''}">${shortHwid(b.hwid)}</code></td>
        <td>${b.reason}</td>
        <td>${b.by}</td>
        <td>${b.permanent ? '∞' : (b.until || '—')}</td>
        <td><span class="badge ${b.active ? 'active' : 'inactive'}">${b.active ? 'Активен' : 'Снят'}</span></td>
        <td>
          <button class="btn-ghost" type="button" data-ban-toggle="${b.player || ''}" data-ban-hwid="${b.hwid || ''}" data-active="${!b.active}">
            ${b.active ? 'Снять' : 'Вернуть'}
          </button>
        </td>
      </tr>
    `).join('')
    : '<tr><td colspan="7" class="muted">Список пуст</td></tr>';

  document.querySelectorAll('[data-ban-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api('/api/bans/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            player: btn.dataset.banToggle || undefined,
            hwid: btn.dataset.banHwid || undefined,
            active: btn.dataset.active === 'true'
          })
        });
        await refresh();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

function renderSessions(d) {
  const rows = d.sessions || [];
  $('sessions-body').innerHTML = rows.length
    ? rows.map((s) => `
      <tr>
        <td>${fmtDate(s.startedAt)}</td>
        <td>${fmtDate(s.endedAt)}</td>
        <td>${s.username || '—'}</td>
        <td>${s.outcome || '—'}</td>
        <td>${(s.events || []).length}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="5" class="muted">Сессии появятся после запусков</td></tr>';
}

function renderLogView(d) {
  const view = $('log-view');
  if (state.logTab === 'launcher') {
    view.textContent = (d.launcherLog || []).join('\n') || 'Журнал лаунчера пуст.';
    return;
  }
  if (state.logTab === 'game') {
    view.textContent = d.gameLogs?.latest || 'Файл latest.log пуст или отсутствует.';
    return;
  }
  if (state.logTab === 'debug') {
    view.textContent = d.gameLogs?.debug || 'Файл debug.log пуст или отсутствует.';
    return;
  }
  const lines = [
    ...(d.gameActivity || []).map((e) => `[${e.at}] ${e.line}`),
    ...(d.storedActivity || []).map((e) => `[${fmtDate(e.at)}] ${e.type}: ${e.detail || ''}`)
  ];
  view.textContent = lines.join('\n') || 'Активность не зафиксирована.';
}

function renderAll(d) {
  state.data = d;
  renderDashboard(d);
  renderPlayers(d);
  renderBans(d);
  renderSessions(d);
  renderLogView(d);
}

async function refreshClients() {
  const res = await api('/api/clients');
  if (state.data) {
    state.data.clients = { online: res.clients, total: res.clients?.length || 0 };
    renderClients(res.clients || []);
    const online = res.clients?.length ?? 0;
    const card = $('dash-cards')?.querySelectorAll('.stat-card')?.[3];
    if (card) card.querySelector('.stat-value').textContent = String(online);
  }
}

async function refresh() {
  const d = await api('/api/dashboard');
  renderAll(d);
}

async function initAuth() {
  const status = await api('/api/auth/status');
  state.configured = status.configured;
  if (status.authed) {
    showApp();
    await refresh();
    return;
  }
  showAuth(status.configured ? 'login' : 'setup');
}

function bindUi() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      state.logTab = tab.dataset.log;
      if (state.data) renderLogView(state.data);
    });
  });

  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('auth-password').value;
    const path = state.configured ? '/api/auth/login' : '/api/auth/setup';
    $('auth-error').hidden = true;
    try {
      await api(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      $('auth-password').value = '';
      showApp();
      await refresh();
    } catch (err) {
      $('auth-error').textContent = err.message;
      $('auth-error').hidden = false;
    }
  });

  $('logout-btn')?.addEventListener('click', () => {
    document.cookie = 'pgc_admin=; Path=/; Max-Age=0';
    state.authed = false;
    location.reload();
  });

  $('ban-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/bans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          player: $('ban-player').value.trim(),
          hwid: $('ban-hwid').value.trim(),
          reason: $('ban-reason').value.trim(),
          by: $('ban-by').value.trim() || 'Админ-панель',
          permanent: $('ban-permanent').checked
        })
      });
      $('ban-form').reset();
      $('ban-permanent').checked = true;
      await refresh();
    } catch (err) {
      alert(err.message);
    }
  });

  setInterval(() => {
    $('panel-clock').textContent = new Date().toLocaleString('ru-RU');
  }, 1000);
}

bindUi();
initAuth().catch((err) => {
  showAuth('login');
  $('auth-error').textContent = err.message;
  $('auth-error').hidden = false;
});

setInterval(() => {
  if (!state.authed) return;
  refresh().catch(() => {});
}, 12000);

setInterval(() => {
  if (!state.authed) return;
  refreshClients().catch(() => {});
}, 5000);
