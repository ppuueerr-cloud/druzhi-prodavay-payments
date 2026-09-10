/**
 * Vercel serverless-функция — приём вебхука от Т-Кассы.
 *
 * POST /api/notification — сюда Т-Касса сама присылает уведомление,
 * когда статус платежа меняется. Мы проверяем подпись запроса и, если
 * платёж подтверждён (CONFIRMED), отправляем уведомление менеджеру
 * в Telegram.
 *
 * Переменные окружения:
 *   TERMINAL_PASSWORD — Password терминала (секрет!) — тот же, что и в init.js
 *   BOT_TOKEN         — токен Telegram-бота от @BotFather (секрет!)
 *   CHAT_ID           — chat_id менеджера, куда слать уведомления
 */

const https = require('https');
const crypto = require('crypto');

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function buildToken(flatParams, password) {
  const all = { ...flatParams, Password: password };
  const keys = Object.keys(all).sort();
  const concatenated = keys.map((k) => String(all[k])).join('');
  return sha256Hex(concatenated);
}

// Обычный https.request к api.telegram.org — сертификат Telegram
// стандартный (доверенный всеми), поэтому специальный ca тут не нужен.
function sendTelegramMessage(botToken, chatId, text) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ chat_id: chatId, text: text });
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: '/bot' + botToken + '/sendMessage',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      }
    );
    req.on('error', () => resolve());
    req.write(data);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(200).send('OK');
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (err) {
      res.status(200).send('OK');
      return;
    }
  }
  if (!body || typeof body !== 'object') {
    res.status(200).send('OK');
    return;
  }

  const received = { ...body };
  delete received.Token;
  delete received.Data; // вложенный объект, в подписи не участвует
  delete received.Receipt;

  const expectedToken = buildToken(received, process.env.TERMINAL_PASSWORD);

  if (expectedToken !== body.Token) {
    // Подпись не совпала — скорее всего, запрос не от Т-Кассы. Игнорируем.
    res.status(200).send('OK');
    return;
  }

  // Успешный платёж при обычной (одностадийной) оплате приходит со
  // статусом CONFIRMED.
  if (body.Status === 'CONFIRMED') {
    // Т-Касса не возвращает обратно поля DATA (name/email/phone) —
    // имя/email/телефон клиента уже были отправлены менеджеру отдельным
    // сообщением из /api/init в момент создания заказа. Здесь только
    // подтверждаем сам факт оплаты и реальную сумму, привязка — по OrderId.
    const amountRubles = (Number(body.Amount || 0) / 100).toLocaleString('ru-RU');
    const text =
      'Оплата подтверждена — марафон «Дружи и Продавай», ' + amountRubles + ' ₽\n' +
      'Заказ: ' + (body.OrderId || '—');

    try {
      await sendTelegramMessage(process.env.BOT_TOKEN, process.env.CHAT_ID, text);
    } catch (err) {
      // Не критично для ответа Т-Кассе — она ждёт просто "OK".
    }
  }

  res.status(200).send('OK');
};
