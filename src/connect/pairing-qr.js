import QRCode from 'qrcode';

export function pairingExpired(pair, now = Date.now()) {
  const expiry = typeof pair?.expiresAt === 'number' ? pair.expiresAt : Date.parse(pair?.expiresAt);
  return !Number.isFinite(expiry) || expiry <= now;
}

export function pairingExpiryLabel(pair, now = Date.now()) {
  if (pairingExpired(pair, now)) return 'Expired. Create a new pairing link.';
  const expiry = typeof pair.expiresAt === 'number' ? pair.expiresAt : Date.parse(pair.expiresAt);
  return `Expires ${new Date(expiry).toLocaleTimeString()}`;
}

export async function createPairingQrDataUrl(pair, { toDataURL = QRCode.toDataURL } = {}) {
  if (!pair?.url || typeof pair.url !== 'string') throw new Error('A pairing URL is required to create a QR code.');
  return toDataURL(pair.url, { errorCorrectionLevel: 'M', margin: 1, width: 320 });
}
