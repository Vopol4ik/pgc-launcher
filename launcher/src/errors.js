'use strict';

function formatLaunchError(err) {
  if (!err) return 'Неизвестная ошибка';

  if (err.name === 'AggregateError' || err.constructor?.name === 'AggregateError') {
    const parts = (err.errors || [])
      .map((e) => e?.message || e?.code || String(e))
      .filter(Boolean);
    if (parts.length) {
      return `Сеть недоступна: ${parts.join('; ')}`;
    }
  }

  const msg = err.message || String(err);
  if (msg === 'AggregateError' || msg.includes('AggregateError')) {
    return 'Сеть недоступна. Проверьте интернет или установите Java 17 вручную.';
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET/i.test(msg)) {
    if (msg.includes('content.7z') || msg.includes('operativniki') || msg.includes('minerent') || msg.includes('GitHub')) {
      return (
        'Не удалось скачать сборку. Проверьте интернет или загрузите content.7z в GitHub Release '
        + '«modpack-latest» (репозиторий globalwar-updates), затем перезапустите лаунчер.'
      );
    }
    return `Нет связи с сервером: ${msg}`;
  }
  return msg;
}

module.exports = { formatLaunchError };
