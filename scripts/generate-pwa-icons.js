// Generates the installable-app icons from the master logo.
//   node scripts/generate-pwa-icons.js
// - Maskable icons: full-bleed brand background with the logo inside the
//   safe zone, so Android can crop them to a circle/squircle without clipping.
// - apple-touch-icon: iOS ignores transparency (it paints it black), so it
//   gets a solid brand background too.
const path = require('node:path');
const sharp = require('sharp');

const images = path.join(__dirname, '..', 'public', 'images');
const source = path.join(images, 'Crowdwide_logo.png');
const BACKGROUND = '#080914';

async function icon(size, logoRatio, outputName) {
  const logoSize = Math.round(size * logoRatio);
  // The master logo has a wide transparent margin; trim it so the ratio below is the real artwork size.
  const logo = await sharp(await sharp(source).trim({ threshold: 20 }).toBuffer()).resize(logoSize, logoSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BACKGROUND } })
    .composite([{ input: logo, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toFile(path.join(images, outputName));
  console.log(`wrote ${outputName}`);
}

(async () => {
  await icon(512, 0.84, 'Crowdwide_icon_maskable_512.png');
  await icon(192, 0.84, 'Crowdwide_icon_maskable_192.png');
  await icon(180, 0.94, 'Crowdwide_apple_touch_180.png');
})().catch((error) => { console.error(error); process.exit(1); });
