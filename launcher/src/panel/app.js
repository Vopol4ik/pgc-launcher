'use strict';

const state = {
  data: null,
  logTab: 'launcher'
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

async function api(path, options) {
  const res = await fetch(path, {
    headers: { Accept: 'application/json', ...(options?.headers || {}) },
    ...options
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function setView(name) {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.view === name);
  });
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('is-active', view.id === `view-${name}`);
  });
}

function renderDashboard(d) {
  const srv = d.serverStatus || {};
  const cards = [
    { label: 'Версия лаунчера', value: d.appVersion || '—' },
    { label: 'Minecraft', value: `${d.minecraft?.version || '—'} · Forge ${d.minecraft?.forgeVersion || '—'}` },
    { label: 'Онлайн сервера', value: srv.online ? String(srv.playersOnline ?? 0) : 'офлайн', cls: srv.online ? 'ok' : 'bad' },
    { label: 'Активных банов', value: String(d.bans?.count ?? 0), cls: d.bans?.count ? 'warn' : '' },
    { label: 'Текущий ник', value: d.currentUser || '—' },
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

  const events = (d.liveSession?.events || []).slice(-12);
  $('dash-live').textContent = events.length
    ? events.map((e) => `[${fmtDate(e.at)}] ${e.type}${e.detail ? ` — ${e.detail}` : ''}`).join('\n')
    : 'Событий текущей сессии пока нет.';

  const pill = $('panel-status');
  pill.textContent = srv.online ? 'Сервер онлайн' : 'Сервер офлайн';
  pill.className = `pill ${srv.online ? 'is-online' : 'is-offline'}`;
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
  $('bans-path').textContent = `${d.paths?.panelDir || 'client/panel-data'}\\bans.json`;
  const rows = d.bans?.all || [];
  $('bans-body').innerHTML = rows.length
    ? rows.map((b) => `
      <tr>
        <td><strong>${b.player}</strong></td>
        <td>${b.reason}</td>
        <td>${b.by}</td>
        <td>${b.permanent ? '∞' : (b.until || '—')}</td>
        <td><span class="badge ${b.active ? 'active' : 'inactive'}">${b.active ? 'Активен' : 'Снят'}</span></td>
        <td>
          <button class="btn-ghost" type="button" data-ban-toggle="${b.player}" data-active="${!b.active}">
            ${b.active ? 'Снять' : 'Вернуть'}
          </button>
        </td>
      </tr>
    `).join('')
    : '<tr><td colspan="6" class="muted">Список пуст</td></tr>';

  document.querySelectorAll('[data-ban-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api('/api/bans/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            player: btn.dataset.banToggle,
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

async function refresh() {
  const d = await api('/api/dashboard');
  renderAll(d);
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

  $('ban-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/bans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          player: $('ban-player').value.trim(),
          reason: $('ban-reason').value.trim(),
          by: $('ban-by').value.trim() || 'Локальная панель',
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
refresh().catch((err) => {
  $('panel-status').textContent = 'Ошибка загрузки';
  $('dash-cards').innerHTML = `<article class="stat-card"><div class="stat-value bad">${err.message}</div></article>`;
});

setInterval(() => {
  refresh().catch(() => {});
}, 12000);
