'use strict';

const { exec } = require('child_process');
const config = require('../src/config');
const {
  startPanelServer,
  stopPanelServer,
  getPanelServerInfo
} = require('../src/panel-server');
const { ensurePanelData, readLauncherJournalFile } = require('../src/panel-store');

function getPanelLiveData() {
  return {
    settings: {},
    sessionStartedAt: null,
    sessionEvents: [],
    launcherJournal: readLauncherJournalFile(),
    panelUrl: getPanelServerInfo().url
  };
}

function openBrowser(url) {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd);
}

async function main() {
  await ensurePanelData();
  const host = process.env.PGC_PANEL_HOST || config.panel?.bindHost || '127.0.0.1';
  const port = Number(process.env.PGC_PANEL_PORT || config.panel?.port) || 17890;
  const info = await startPanelServer(getPanelLiveData, { host, port });
  const openUrl = info.url;

  console.log('');
  console.log('  PGC Admin Panel');
  console.log(`  ${openUrl}`);
  if (host === '0.0.0.0') {
    console.log('  Доступ из сети: укажите remoteUrl в config.js для лаунчеров игроков');
  }
  console.log('  Первый вход: задайте пароль администратора в браузере');
  console.log('  Ctrl+C — остановить');
  console.log('');

  openBrowser(openUrl);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

process.on('SIGINT', () => {
  stopPanelServer();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopPanelServer();
  process.exit(0);
});
