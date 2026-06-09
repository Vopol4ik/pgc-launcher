'use strict';

function maskWebhook(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  try {
    const u = new URL(value);
    const parts = u.pathname.split('/');
    const token = parts.pop() || '';
    if (token.length <= 8) return `${u.origin}${parts.join('/')}/***`;
    return `${u.origin}${parts.join('/')}/${token.slice(0, 4)}…${token.slice(-4)}`;
  } catch {
    return '***';
  }
}

/** Убирает чувствительные поля из настроек перед отправкой в renderer. */
function sanitizeSettingsForRenderer(settings) {
  const copy = { ...settings };
  delete copy.savedPasswordEnc;
  delete copy.savedPassword;
  delete copy.password;
  delete copy.passwordSalt;
  delete copy.passwordHash;
  delete copy.rememberPassword;
  delete copy.authSession;

  copy.registered = Boolean(settings?.registered);

  copy.logEncryptKeyConfigured = Boolean(String(settings?.logEncryptKey || '').length >= 8);
  delete copy.logEncryptKey;

  if (copy.discordWebhookUrl) {
    copy.discordWebhookConfigured = true;
    copy.discordWebhookUrl = maskWebhook(copy.discordWebhookUrl);
  } else {
    copy.discordWebhookConfigured = false;
  }

  return copy;
}

module.exports = { sanitizeSettingsForRenderer };
