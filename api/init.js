/**
 * Vercel serverless-функция — платёжный бэкенд для марафона «Дружи и Продавай».
 *
 * POST /api/init — принимает { name, email, phone } с сайта,
 * создаёт заказ в Т-Кассе (Tinkoff Init) и возвращает { paymentUrl }
 * для редиректа пользователя на страницу оплаты.
 *
 * В отличие от старой версии на Cloudflare Workers, здесь мы используем
 * встроенный в Node.js модуль https и явно указываем доверенные
 * сертификаты Минцифры (Russian Trusted CA) — это нужно, потому что
 * securepay.tinkoff.ru теперь использует именно такие сертификаты,
 * а Cloudflare Workers не даёт способа их подключить.
 *
 * Переменные окружения (задаются в настройках проекта на vercel.com,
 * Settings → Environment Variables):
 *   TERMINAL_KEY      — TerminalKey из личного кабинета Т-Business
 *   TERMINAL_PASSWORD — Password терминала (секрет!)
 *   SITE_URL          — публичный адрес сайта, например
 *                        https://druzhi-prodavay.pages.dev
 *                        (без слэша на конце)
 *   BOT_TOKEN         — токен Telegram-бота от @BotFather (секрет!)
 *   CHAT_ID           — chat_id менеджера, куда слать уведомления
 *
 * ВАЖНО: Т-Касса НЕ возвращает обратно поля DATA (name/email/phone) в
 * вебхуке /api/notification — банк их просто не эхо́ит. Поэтому имя,
 * email и телефон клиента отправляются менеджеру в Telegram СРАЗУ здесь,
 * в момент создания заказа (ещё до того, как клиент оплатил), а
 * /api/notification потом присылает второе сообщение — уже про то, что
 * деньги реально пришли, с привязкой по номеру заказа (OrderId).
 */

const https = require('https');
const crypto = require('crypto');
const { RUSSIAN_TRUSTED_CERTS } = require('../lib/certs');

const AMOUNT_KOPECKS = 495000; // 4 950 ₽ — боевая цена марафона
const DESCRIPTION = 'Марафон «Дружи и Продавай»';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// Подпись запроса по правилам Т-Кассы: берём все ПЛОСКИЕ (не вложенные)
// поля запроса, добавляем Password, сортируем ключи по алфавиту,
// склеиваем только значения и хэшируем SHA-256.
function buildToken(flatParams, password) {
  const all = { ...flatParams, Password: password };
  const keys = Object.keys(all).sort();
  const concatenated = keys.map((k) => String(all[k])).join('');
  return sha256Hex(concatenated);
}

function makeOrderId() {
  return 'ord' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Делаем HTTPS-запрос к Т-Кассе через встроенный модуль https,
// явно передавая доверенные сертификаты Минцифры.
function postJson(hostname, path, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj);
    const req = https.request(
      {
        hostname,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        },
        ca: RUSSIAN_TRUSTED_CERTS,
      },
      (res) => {
        let chunks = '';
        res.on('data', (chunk) => (chunks += chunk));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: chunks });
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Обычный https.request к api.telegram.org — сертификат Telegram
// стандартный (доверенный всеми), поэтому специальный ca тут не нужен.
function sendTelegramMessage(botToken, chatId, text) {
  return new Promise((resolve) => {
    if (!botToken || !chatId) {
      resolve();
      return;
    }
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
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (err) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
  }
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'bad_request' });
    return;
  }

  const name = String(body.name || '').trim().slice(0, 100);
  const email = String(body.email || '').trim().slice(0, 100);
  const phone = String(body.phone || '').trim().slice(0, 100);

  if (!name || !phone) {
    res.status(400).json({ error: 'missing_fields' });
    return;
  }

  const orderId = makeOrderId();
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const origin = proto + '://' + req.headers.host;
  const siteUrl = (process.env.SITE_URL || origin).replace(/\/$/, '');

  const flatParams = {
    TerminalKey: process.env.TERMINAL_KEY,
    Amount: AMOUNT_KOPECKS,
    OrderId: orderId,
    Description: DESCRIPTION,
    NotificationURL: origin + '/api/notification',
    SuccessURL: siteUrl + '/?payment=success&order=' + orderId,
    FailURL: siteUrl + '/?payment=fail&order=' + orderId,
  };

  const token = buildToken(flatParams, process.env.TERMINAL_PASSWORD);

  // Терминал требует обязательный кассовый чек (54-ФЗ). У ИП — патентная
  // система налогообложения (ПСН), поэтому Taxation = 'patent', а налог
  // по позиции — 'none' (патент не облагается НДС отдельно).
  const receipt = {
    Email: email || undefined,
    Phone: phone,
    Taxation: 'patent',
    Items: [
      {
        Name: DESCRIPTION,
        Price: AMOUNT_KOPECKS,
        Quantity: 1,
        Amount: AMOUNT_KOPECKS,
        Tax: 'none',
      },
    ],
  };

  const tinkoffRequestBody = {
    ...flatParams,
    Token: token,
    DATA: {
      name: name,
      email: email || '-',
      phone: phone,
    },
    Receipt: receipt,
  };

  let result;
  try {
    const resp = await postJson('securepay.tinkoff.ru', '/v2/Init', tinkoffRequestBody);
    try {
      result = JSON.parse(resp.body);
    } catch (parseErr) {
      res.status(502).json({
        error: 'tinkoff_bad_response',
        debug: resp.body.slice(0, 300),
        statusCode: resp.statusCode,
      });
      return;
    }
  } catch (err) {
    res.status(502).json({
      error: 'tinkoff_unreachable',
      debug: String((err && err.message) || err),
      name: (err && err.name) || '',
    });
    return;
  }

  if (!result || !result.Success) {
    res.status(502).json({
      error: 'tinkoff_error',
      message: (result && result.Message) || '',
      details: (result && result.Details) || '',
      errorCode: (result && result.ErrorCode) || '',
      terminalKeyUsed: process.env.TERMINAL_KEY || '',
      passwordLength: (process.env.TERMINAL_PASSWORD || '').length,
      sentParams: flatParams,
    });
    return;
  }

  // Отправляем менеджеру данные клиента сразу — Т-Касса не возвращает их
  // обратно в /api/notification, поэтому единственный надёжный момент
  // их отправить — прямо сейчас, пока они у нас есть.
  const amountRubles = (AMOUNT_KOPECKS / 100).toLocaleString('ru-RU');
  const orderText =
    'Новая заявка — марафон «Дружи и Продавай», ' + amountRubles + ' ₽\n' +
    'Имя: ' + (name || '—') + '\n' +
    'Email: ' + (email || '—') + '\n' +
    'Телефон: ' + (phone || '—') + '\n' +
    'Заказ: ' + orderId + '\n' +
    '(ожидает оплаты)';

  try {
    await sendTelegramMessage(process.env.BOT_TOKEN, process.env.CHAT_ID, orderText);
  } catch (err) {
    // Не критично для ответа клиенту — он должен попасть на страницу оплаты в любом случае.
  }

  res.status(200).json({ paymentUrl: result.PaymentURL, orderId: orderId });
};
