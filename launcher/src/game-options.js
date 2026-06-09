'use strict';

const fs = require('fs');
const path = require('path');
const fsp = require('fs/promises');

// В меню MC ползунок ≈ mouseSensitivity * 200 (0.335 → 67%).
const DEFAULTS = {
  mouseSensitivity: 0.335,
  renderDistance: 28,
  simulationDistance: 5,
  fov: 0.975,
  maxFps: 260,
  gamma: 0.8,
  soundCategory_master: 0.4,
  fullscreen: true,
  lang: 'ru_ru',
  guiScale: 2
};

/** Фиксированные бинды поверх снимка профиля. */
const KEY_OVERRIDES = {
  'key_iris.keybind.reload': 'key.keyboard.unknown',
  'key_iris.keybind.toggleShaders': 'key.keyboard.unknown',
  'key_iris.keybind.shaderPackSelection': 'key.keyboard.unknown',
  'key_key.voice_chat_settings': 'key.keyboard.i',
  'key_key.ywzj_vehicle.change_seat.desc': 'key.keyboard.x',
  'key_key.vvp.seat_selector': 'key.keyboard.x'
};

function parseOptions(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i < 1) continue;
    map.set(line.slice(0, i), line.slice(i + 1));
  }
  return map;
}

function serializeOptions(map) {
  return [...map.entries()].map(([k, v]) => `${k}:${v}`).join('\n') + '\n';
}

async function applyGameOptions(gameDir, modpackSource, overrides = {}) {
  const optionsPath = path.join(gameDir, 'options.txt');
  await fsp.mkdir(gameDir, { recursive: true });

  // Уже играли — не затираем графику, чувствительность мыши и т.д.
  if (fs.existsSync(optionsPath)) {
    const map = parseOptions(await fsp.readFile(optionsPath, 'utf8'));
    for (const [key, value] of Object.entries(KEY_OVERRIDES)) {
      map.set(key, value);
    }
    await fsp.writeFile(optionsPath, serializeOptions(map), 'utf8');
    return { fresh: false };
  }

  let map = new Map();
  if (modpackSource) {
    const snapshot = path.join(modpackSource, 'options-default.txt');
    if (fs.existsSync(snapshot)) {
      map = parseOptions(await fsp.readFile(snapshot, 'utf8'));
    } else {
      const templatePath = path.join(modpackSource, 'options.txt');
      if (fs.existsSync(templatePath)) {
        map = parseOptions(await fsp.readFile(templatePath, 'utf8'));
      }
    }
  }

  for (const [key, value] of Object.entries({ ...DEFAULTS, ...overrides })) {
    if (value !== undefined && value !== null) {
      map.set(key, String(value));
    }
  }

  for (const [key, value] of Object.entries(KEY_OVERRIDES)) {
    map.set(key, value);
  }

  await fsp.writeFile(optionsPath, serializeOptions(map), 'utf8');
  return { fresh: true };
}

module.exports = { applyGameOptions };
