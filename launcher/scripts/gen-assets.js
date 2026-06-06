'use strict';

const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const pngToIco = require('png-to-ico');

const root = path.join(__dirname, '..');
const repoRoot = path.join(root, '..');
const buildDir = path.join(root, 'build');
const logoCandidates = [
  path.join(root, 'src', 'renderer', 'logo.png'),
  path.join(repoRoot, 'assets', 'pgc-logo.png')
];

function resolveLogo() {
  const file = logoCandidates.find((p) => fs.existsSync(p));
  if (!file) {
    throw new Error('logo.png не найден — положите аватар в launcher/src/renderer/logo.png');
  }
  return file;
}

async function squareIcon(source, size) {
  const w = source.bitmap.width;
  const h = source.bitmap.height;
  const side = Math.min(w, h);
  const x = Math.floor((w - side) / 2);
  const y = Math.floor((h - side) / 2);
  return source.clone().crop(x, y, side, side).resize(size, size, Jimp.RESIZE_BICUBIC);
}

function applyRoundedMask(img, radiusRatio = 0.22) {
  const { width, height } = img.bitmap;
  const r = Math.max(2, Math.round(width * radiusRatio));
  const r2 = r * r;
  img.scan(0, 0, width, height, (x, y, idx) => {
    let inside = true;
    if (x < r && y < r) {
      inside = (x - r + 1) ** 2 + (y - r + 1) ** 2 <= r2;
    } else if (x >= width - r && y < r) {
      inside = (x - (width - r)) ** 2 + (y - r + 1) ** 2 <= r2;
    } else if (x < r && y >= height - r) {
      inside = (x - r + 1) ** 2 + (y - (height - r)) ** 2 <= r2;
    } else if (x >= width - r && y >= height - r) {
      inside = (x - (width - r)) ** 2 + (y - (height - r)) ** 2 <= r2;
    }
    if (!inside) {
      img.bitmap.data[idx + 3] = 0;
    }
  });
  return img;
}

async function coverImage(source, width, height) {
  return source.clone().cover(width, height);
}

async function writeBmpFromImage(file, width, height, source) {
  const img = await coverImage(source, width, height);
  await img.writeAsync(file.replace(/\.bmp$/i, '.png'));
  const pngPath = file.replace(/\.bmp$/i, '.png');
  const loaded = await Jimp.read(pngPath);
  const rgba = loaded.bitmap.data;
  const row = width * 3;
  const pad = (4 - (row % 4)) % 4;
  const rowSize = row + pad;
  const pixels = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y += 1) {
    const dstRow = (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x += 1) {
      const src = (y * width + x) * 4;
      const dst = dstRow + x * 3;
      pixels[dst] = rgba[src + 2];
      pixels[dst + 1] = rgba[src + 1];
      pixels[dst + 2] = rgba[src];
    }
  }
  const fileSize = 14 + 40 + pixels.length;
  const header = Buffer.alloc(14 + 40);
  header.write('BM');
  header.writeUInt32LE(fileSize, 2);
  header.writeUInt32LE(14 + 40, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  fs.writeFileSync(file, Buffer.concat([header, pixels]));
  fs.rmSync(pngPath, { force: true });
}

async function main() {
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'assets'), { recursive: true });

  const logoPath = resolveLogo();
  const brandPath = path.join(repoRoot, 'assets', 'pgc-logo.png');
  if (path.resolve(logoPath) !== path.resolve(brandPath)) {
    fs.copyFileSync(logoPath, brandPath);
  }

  const source = await Jimp.read(logoPath);
  const iconSizes = [16, 32, 48, 64, 128, 256];
  const pngPaths = [];
  for (const size of iconSizes) {
    const out = path.join(buildDir, `icon-${size}.png`);
    let icon = await squareIcon(source, size);
    icon = applyRoundedMask(icon, 0.22);
    await icon.writeAsync(out);
    pngPaths.push(out);
  }

  const icon256 = path.join(buildDir, 'icon.png');
  fs.copyFileSync(path.join(buildDir, 'icon-256.png'), icon256);
  fs.copyFileSync(icon256, path.join(root, 'src', 'assets', 'app-icon.png'));
  fs.copyFileSync(logoPath, path.join(root, 'src', 'renderer', 'logo.png'));

  const ico = await pngToIco(pngPaths);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);

  await writeBmpFromImage(path.join(buildDir, 'installerHeader.bmp'), 150, 57, source);
  await writeBmpFromImage(path.join(buildDir, 'installerSidebar.bmp'), 164, 314, source);

  console.log('Аватар PGC применён:', logoPath);
  console.log('Сгенерировано:', buildDir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
