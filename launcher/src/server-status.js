'use strict';

const dns = require('dns').promises;
const net = require('net');
const config = require('./config');
const { fetchJson } = require('./download');

const CACHE_MS = 15000;
let cached = null;
let cacheExpires = 0;
let inflight = null;

function writeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  while (true) {
    if ((v & ~0x7f) === 0) {
      bytes.push(v);
      break;
    }
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return Buffer.from(bytes);
}

function readVarInt(buffer, offset = 0) {
  let numRead = 0;
  let result = 0;
  let read;
  do {
    if (offset + numRead >= buffer.length) {
      throw new Error('Недостаточно данных для VarInt');
    }
    read = buffer[offset + numRead];
    const value = read & 0x7f;
    result |= value << (7 * numRead);
    numRead += 1;
    if (numRead > 5) throw new Error('VarInt слишком длинный');
  } while ((read & 0x80) !== 0);
  return { value: result, bytes: numRead };
}

function writeString(str) {
  const body = Buffer.from(String(str), 'utf8');
  return Buffer.concat([writeVarInt(body.length), body]);
}

function writePacket(packetId, payload = Buffer.alloc(0)) {
  const body = Buffer.concat([writeVarInt(packetId), payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

function writeUShort(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value & 0xffff);
  return buf;
}

function writeLong(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(value));
  return buf;
}

function createSocketReader(socket, timeoutMs) {
  let buffer = Buffer.alloc(0);
  const waiters = [];
  let timer = null;

  function resetTimer() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const err = new Error('Таймаут сервера');
      while (waiters.length > 0) {
        waiters.shift().reject(err);
      }
      socket.destroy();
    }, timeoutMs);
  }

  function flushWaiters() {
    while (waiters.length > 0) {
      const waiter = waiters[0];
      if (buffer.length < waiter.size) return;
      const chunk = buffer.subarray(0, waiter.size);
      buffer = buffer.subarray(waiter.size);
      waiters.shift();
      waiter.resolve(chunk);
    }
  }

  function readExact(size) {
    return new Promise((resolve, reject) => {
      if (buffer.length >= size) {
        const chunk = buffer.subarray(0, size);
        buffer = buffer.subarray(size);
        return resolve(chunk);
      }
      waiters.push({ size, resolve, reject });
    });
  }

  async function readVarIntFromSocket() {
    const bytes = [];
    while (bytes.length < 5) {
      const chunk = await readExact(1);
      bytes.push(chunk[0]);
      if ((chunk[0] & 0x80) === 0) break;
    }
    return readVarInt(Buffer.from(bytes), 0).value;
  }

  async function readPacket() {
    const length = await readVarIntFromSocket();
    const body = await readExact(length);
    const packetIdInfo = readVarInt(body, 0);
    return {
      id: packetIdInfo.value,
      payload: body.subarray(packetIdInfo.bytes)
    };
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    flushWaiters();
  });

  resetTimer();
  return {
    readPacket,
    clear() {
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}

async function resolveServerTarget() {
  const host = config.brand?.server || 'localhost';
  const configuredPort = Number(config.brand?.port) || 0;
  if (configuredPort > 0) {
    return { host, port: configuredPort, virtualHost: host };
  }

  try {
    const records = await dns.resolveSrv(`_minecraft._tcp.${host}`);
    const record = records.sort((a, b) => (b.priority - a.priority) || (a.weight - b.weight))[0];
    if (record) {
      return {
        host: record.name.replace(/\.$/, ''),
        port: record.port,
        virtualHost: host
      };
    }
  } catch {
    // SRV недоступен
  }

  const meta = await fetchMcsrvstat(host);
  if (meta?.target) return meta.target;
  return { host, port: 25565, virtualHost: host };
}

async function fetchMcsrvstat(host) {
  const meta = await fetchJson(
    `https://api.mcsrvstat.us/3/${encodeURIComponent(host)}`,
    0,
    { allowMcsrvstat: true }
  );
  const target = meta?.port
    ? { host: meta.ip || host, port: meta.port, virtualHost: host }
    : null;
  return {
    online: Boolean(meta.online),
    playersOnline: meta.players?.online ?? null,
    playersMax: meta.players?.max ?? null,
    target
  };
}

function pingMinecraftServer(target, timeoutMs = 7000) {
  const { host, port, virtualHost = config.brand?.server || host } = target;
  const protocol = Number(config.minecraft?.protocol) || 763;

  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const reader = createSocketReader(socket, timeoutMs);

    socket.once('error', (err) => {
      reader.clear();
      reject(err);
    });

    socket.once('connect', async () => {
      try {
        const handshakePayload = Buffer.concat([
          writeVarInt(protocol),
          writeString(virtualHost),
          writeUShort(port),
          writeVarInt(1)
        ]);
        socket.write(writePacket(0x00, handshakePayload));
        socket.write(writePacket(0x00));

        const statusPacket = await reader.readPacket();
        if (statusPacket.id !== 0x00) {
          throw new Error('Неожиданный ответ статуса');
        }

        const jsonInfo = readVarInt(statusPacket.payload, 0);
        const jsonText = statusPacket.payload
          .subarray(jsonInfo.bytes, jsonInfo.bytes + jsonInfo.value)
          .toString('utf8');
        const status = JSON.parse(jsonText);

        const pingStart = Date.now();
        socket.write(writePacket(0x01, writeLong(pingStart)));
        await reader.readPacket();
        const pingMs = Math.max(1, Date.now() - pingStart);

        reader.clear();
        socket.end();
        resolve({
          online: true,
          playersOnline: status?.players?.online ?? 0,
          playersMax: status?.players?.max ?? 0,
          pingMs
        });
      } catch (err) {
        reader.clear();
        socket.destroy();
        reject(err);
      }
    });
  });
}

async function fetchTpsFromApi() {
  const url = config.brand?.statusUrl;
  if (!url) return null;
  try {
    const data = await fetchJson(url);
    const raw = data?.tps ?? data?.TPS ?? data?.performance?.tps;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function fetchServerStatus(force = false) {
  const now = Date.now();
  if (!force && cached && now < cacheExpires) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    const host = config.brand?.server || 'localhost';
    let result = {
      ok: false,
      online: false,
      playersOnline: null,
      playersMax: null,
      pingMs: null,
      tps: null,
      host,
      error: null
    };

    let meta = null;
    try {
      meta = await fetchMcsrvstat(host);
    } catch {
      meta = null;
    }

    if (meta && !meta.online) {
      result.error = 'Сервер офлайн';
      cached = result;
      cacheExpires = Date.now() + CACHE_MS;
      inflight = null;
      return result;
    }

    try {
      const target = meta?.target || await resolveServerTarget();
      const ping = await pingMinecraftServer(target);
      result = {
        ...result,
        ok: true,
        online: true,
        playersOnline: ping.playersOnline,
        playersMax: ping.playersMax,
        pingMs: ping.pingMs
      };
    } catch (err) {
      if (meta?.online) {
        result = {
          ...result,
          ok: true,
          online: true,
          playersOnline: meta.playersOnline,
          playersMax: meta.playersMax,
          pingMs: null,
          error: null
        };
      } else {
        result.error = err.message || 'Сервер недоступен';
      }
    }

    const tps = await fetchTpsFromApi();
    if (tps != null) result.tps = tps;

    cached = result;
    cacheExpires = Date.now() + CACHE_MS;
    inflight = null;
    return result;
  })();

  try {
    return await inflight;
  } catch (err) {
    inflight = null;
    throw err;
  }
}

module.exports = { fetchServerStatus };
