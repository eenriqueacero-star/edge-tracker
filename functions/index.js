const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const TOKEN       = '8793038031:AAF2Zwdm9JZtDWZ7zmR8b9ntqVThUq4txpo';
const API         = `https://api.telegram.org/bot${TOKEN}`;
const FINNHUB_KEY = 'd8fmkt1r01qn443aoep0d8fmkt1r01qn443aoepg';

exports.telegramWebhook = onRequest(async (req, res) => {
  try {
    const update = req.body;
    if (update.message) {
      const chatId = update.message.chat.id;
      const text   = (update.message.text || '').trim();
      if (text.startsWith('/myid') || text.startsWith('/start')) {
        await fetch(`${API}/sendMessage`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id:    chatId,
            parse_mode: 'HTML',
            text: `🔑 <b>Your chat ID is:</b>\n\n<code>${chatId}</code>\n\nCopy that number and paste it into the <b>🔔 Alerts</b> panel in Edge Tracker, then tap <b>Link &amp; Test</b>.`
          })
        });
      }
    }
  } catch (_) {}
  res.sendStatus(200);
});

async function fetchQuote(ticker) {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`);
    const d = await r.json();
    if (d && d.c > 0) return { price: d.c, changePct: d.dp };
  } catch (_) {}
  return null;
}

async function sendTelegram(chatId, text) {
  try {
    await fetch(`${API}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
  } catch (_) {}
}

exports.checkPriceAlerts = onSchedule('every 5 minutes', async () => {
  const snap = await db.collection('users').get();
  if (snap.empty) return;

  // Gather unique tickers across all users who have alerts enabled
  const allTickers = new Set(['SPY']);
  snap.forEach(doc => {
    const { trades = [], alertEnabled } = doc.data();
    if (!alertEnabled) return;
    trades.forEach(t => { if (!t.exitPrice && t.ticker) allTickers.add(t.ticker); });
  });

  // Fetch all prices in parallel
  const tickerArr = [...allTickers];
  const quotes    = await Promise.all(tickerArr.map(tk => fetchQuote(tk)));
  const priceMap  = {};
  tickerArr.forEach((tk, i) => { if (quotes[i]) priceMap[tk] = quotes[i]; });

  const spyQuote = priceMap['SPY'];
  const now      = Date.now();
  const COOLDOWN = 3600000; // 1 hour

  for (const doc of snap.docs) {
    const data = doc.data();
    const {
      alertEnabled,
      alertThreshold = 3,
      telegramChatId,
      trades          = [],
      alertCooldowns  = {}
    } = data;

    if (!alertEnabled || !telegramChatId) continue;

    const openTrades = trades.filter(t => !t.exitPrice && t.ticker);
    if (!openTrades.length) continue;

    const cooldowns = { ...alertCooldowns };
    let changed = false;

    for (const trade of openTrades) {
      const q = priceMap[trade.ticker];
      if (!q) continue;

      // Daily % change alert
      if (q.changePct != null && Math.abs(q.changePct) >= alertThreshold) {
        const dir = q.changePct > 0 ? 'up' : 'down';
        const key = `${trade.ticker}_daily_${dir}`;
        if (!cooldowns[key] || now - cooldowns[key] > COOLDOWN) {
          cooldowns[key] = now;
          changed = true;
          const emoji = q.changePct > 0 ? '🚀' : '⚠️';
          await sendTelegram(telegramChatId,
            `${emoji} <b>${trade.ticker}</b> is ${dir} <b>${q.changePct > 0 ? '+' : ''}${q.changePct.toFixed(2)}%</b> today\nPrice: $${q.price.toFixed(2)}`
          );
        }
      }

      // Alpha vs SPY alert
      if (spyQuote && trade.benchEntry && trade.entryPrice) {
        const tradeRet = (q.price - trade.entryPrice) / trade.entryPrice;
        const spyRet   = (spyQuote.price - trade.benchEntry) / trade.benchEntry;
        const alpha    = tradeRet - spyRet;
        const key      = `${trade.ticker}_alpha_neg`;
        if (alpha < 0) {
          if (!cooldowns[key] || now - cooldowns[key] > COOLDOWN) {
            cooldowns[key] = now;
            changed = true;
            await sendTelegram(telegramChatId,
              `📉 <b>${trade.ticker}</b> alpha turned negative\nLagging SPY by <b>${(alpha * 100).toFixed(2)}%</b> since entry`
            );
          }
        } else if (cooldowns[key]) {
          delete cooldowns[key];
          changed = true;
        }
      }
    }

    if (changed) {
      await doc.ref.set({ alertCooldowns: cooldowns }, { merge: true });
    }
  }
});
