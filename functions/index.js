const { onRequest, onCall } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const TOKEN       = '8793038031:AAF2Zwdm9JZtDWZ7zmR8b9ntqVThUq4txpo';
const API         = `https://api.telegram.org/bot${TOKEN}`;
const FINNHUB_KEY = 'd8fmkt1r01qn443aoep0d8fmkt1r01qn443aoepg';

// ── helpers ────────────────────────────────────────────────────────────────

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
            text: `🔑 <b>Your chat ID is:</b>\n\n<code>${chatId}</code>\n\nCopy that number and paste it into the <b>⚙️ Settings → Stock Price Alerts</b> panel in Edge Tracker, then tap <b>Send Test Message</b>.`
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

async function fetchNews(ticker) {
  try {
    const now  = new Date();
    const from = new Date(now - 7 * 86400000).toISOString().slice(0, 10);
    const to   = now.toISOString().slice(0, 10);
    const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${from}&to=${to}&token=${FINNHUB_KEY}`);
    const d = await r.json();
    if (Array.isArray(d)) return d.slice(0, 5);
  } catch (_) {}
  return [];
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

function newsVerdict(articles, ticker) {
  const combined = articles.map(a => (a.headline + ' ' + (a.summary || '')).toLowerCase()).join(' ');
  const bWords = ['beat','beats','upgrade','upgraded','buy rating','bullish','partnership','deal','launch','growth','record high','profit','revenue beat','raised guidance','expansion','acquisition','contract','strong earnings','positive','optimistic','rally','outperform'];
  const rWords = ['miss','misses','downgrade','downgraded','sell rating','bearish','lawsuit','loss','layoffs','layoff','guidance cut','decline','warns','disappoints','disappointing','fda reject','investigation','recall','fine','penalty','ceo resign','ceo fired','weak','fell short','below estimates'];
  let bull = 0, bear = 0;
  bWords.forEach(w => { if (combined.includes(w)) bull++; });
  rWords.forEach(w => { if (combined.includes(w)) bear++; });
  const sentiment = bull > bear + 1 ? 'Bullish' : bear > bull + 1 ? 'Bearish' : 'Neutral';
  let theme = 'Mixed coverage with no single dominant theme.';
  if (/earnings|revenue|eps|quarterly results/.test(combined)) {
    theme = /beat|exceeded|above estimates|topped/.test(combined) ? 'Earnings beat.' : /miss|fell short|below estimates/.test(combined) ? 'Earnings miss.' : 'Earnings in focus.';
  } else if (/upgrade|downgrade|analyst|price target|rating/.test(combined)) {
    theme = 'Analyst activity — rating or price target change.';
  } else if (/acquisition|merger|deal|takeover|buyout/.test(combined)) {
    theme = 'M&A or partnership news.';
  } else if (/lawsuit|investigation|fine|penalty|sec|ftc/.test(combined)) {
    theme = 'Legal or regulatory headlines.';
  } else if (/guidance|outlook|forecast|raised|lowered/.test(combined)) {
    theme = 'Forward guidance in focus.';
  }
  return { sentiment, theme };
}

// ── admin data ────────────────────────────────────────────────────────────

const ADMIN_EMAIL = 'e.enrique.acero@gmail.com';

exports.getAdminData = onCall(async (request) => {
  if (!request.auth || request.auth.token.email !== ADMIN_EMAIL) {
    throw new Error('Unauthorized');
  }

  const [firestoreSnap, authList] = await Promise.all([
    db.collection('users').get(),
    admin.auth().listUsers()
  ]);

  const authMap = {};
  authList.users.forEach(u => { authMap[u.uid] = u; });

  const users = [];
  firestoreSnap.forEach(doc => {
    const data     = doc.data();
    const authUser = authMap[doc.id];
    const trades   = data.trades || [];
    users.push({
      uid:          doc.id,
      email:        authUser?.email || '—',
      username:     data.username   || '—',
      openTrades:   trades.filter(t => !t.exitPrice).length,
      closedTrades: trades.filter(t =>  t.exitPrice).length,
      createdAt:    authUser?.metadata?.creationTime  || null,
      lastSignIn:   authUser?.metadata?.lastSignInTime || null,
      priceAlerts:  data.priceAlertsEnabled || false,
      newsAlerts:   data.newsAlertsEnabled  || false,
    });
  });

  users.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return { users };
});

// ── price alerts (every 5 min) ─────────────────────────────────────────────

exports.checkPriceAlerts = onSchedule('every 5 minutes', async () => {
  const snap = await db.collection('users').get();
  if (snap.empty) return;

  const allTickers = new Set(['SPY']);
  snap.forEach(doc => {
    const { trades = [], priceAlertsEnabled } = doc.data();
    if (!priceAlertsEnabled) return;
    trades.forEach(t => { if (!t.exitPrice && t.ticker) allTickers.add(t.ticker); });
  });

  const tickerArr = [...allTickers];
  const quotes    = await Promise.all(tickerArr.map(tk => fetchQuote(tk)));
  const priceMap  = {};
  tickerArr.forEach((tk, i) => { if (quotes[i]) priceMap[tk] = quotes[i]; });

  const spyQuote = priceMap['SPY'];
  const now      = Date.now();
  const COOLDOWN = 3600000;

  for (const doc of snap.docs) {
    const data = doc.data();
    const {
      priceAlertsEnabled,
      telegramChatId,
      alertOnDrop5    = true,
      alertOnPump5    = true,
      alertOnAlphaNeg = true,
      alertOnDown10   = false,
      trades           = [],
      alertCooldowns  = {}
    } = data;

    if (!priceAlertsEnabled || !telegramChatId) continue;

    const openTrades = trades.filter(t => !t.exitPrice && t.ticker);
    if (!openTrades.length) continue;

    const cooldowns = { ...alertCooldowns };
    let changed = false;

    for (const trade of openTrades) {
      const q = priceMap[trade.ticker];
      if (!q) continue;

      if (alertOnDrop5 && q.changePct != null && q.changePct <= -5) {
        const key = `${trade.ticker}_daily_down`;
        if (!cooldowns[key] || now - cooldowns[key] > COOLDOWN) {
          cooldowns[key] = now; changed = true;
          await sendTelegram(telegramChatId,
            `⚠️ <b>${trade.ticker}</b> dropped <b>${q.changePct.toFixed(2)}%</b> today\nPrice: $${q.price.toFixed(2)}`);
        }
      }

      if (alertOnPump5 && q.changePct != null && q.changePct >= 5) {
        const key = `${trade.ticker}_daily_up`;
        if (!cooldowns[key] || now - cooldowns[key] > COOLDOWN) {
          cooldowns[key] = now; changed = true;
          await sendTelegram(telegramChatId,
            `🚀 <b>${trade.ticker}</b> is up <b>+${q.changePct.toFixed(2)}%</b> today\nPrice: $${q.price.toFixed(2)}`);
        }
      }

      if (alertOnDown10 && q.changePct != null && q.changePct <= -10) {
        const key = `${trade.ticker}_daily_crash`;
        if (!cooldowns[key] || now - cooldowns[key] > COOLDOWN) {
          cooldowns[key] = now; changed = true;
          await sendTelegram(telegramChatId,
            `🆘 <b>${trade.ticker}</b> crashed <b>${q.changePct.toFixed(2)}%</b> today\nPrice: $${q.price.toFixed(2)}`);
        }
      }

      if (alertOnAlphaNeg && spyQuote && trade.benchEntry && trade.entryPrice) {
        const tradeRet = (q.price - trade.entryPrice) / trade.entryPrice;
        const spyRet   = (spyQuote.price - trade.benchEntry) / trade.benchEntry;
        const alpha    = tradeRet - spyRet;
        const key      = `${trade.ticker}_alpha_neg`;
        if (alpha < -0.05) {
          if (!cooldowns[key] || now - cooldowns[key] > COOLDOWN) {
            cooldowns[key] = now; changed = true;
            await sendTelegram(telegramChatId,
              `📉 <b>${trade.ticker}</b> alpha turned negative\nLagging SPY by <b>${(alpha * 100).toFixed(2)}%</b> since entry`);
          }
        } else if (cooldowns[key]) {
          delete cooldowns[key]; changed = true;
        }
      }
    }

    if (changed) {
      await doc.ref.set({ alertCooldowns: cooldowns }, { merge: true });
    }
  }
});

// ── news alerts (every 30 min) ─────────────────────────────────────────────

exports.checkNewsAlerts = onSchedule('every 30 minutes', async () => {
  const snap = await db.collection('users').get();
  if (snap.empty) return;

  const BREAKING = ['fda reject','recall','bankruptcy','chapter 11','sec charges','fraud','indicted','ceo resign','ceo fired','acquisition','merger','buyout','takeover'];

  for (const doc of snap.docs) {
    const data = doc.data();
    const {
      newsAlertsEnabled,
      telegramChatId,
      alertOnNewArticle      = false,
      alertOnSentimentChange = true,
      alertOnBreaking        = true,
      trades                  = [],
      lastNewsHeadlines       = {},
      lastNewsSentiment       = {}
    } = data;

    if (!newsAlertsEnabled || !telegramChatId) continue;

    const tickers = [...new Set(trades.filter(t => !t.exitPrice && t.ticker).map(t => t.ticker))];
    if (!tickers.length) continue;

    const updatedHeadlines = { ...lastNewsHeadlines };
    const updatedSentiment = { ...lastNewsSentiment };
    let changed = false;

    for (const ticker of tickers) {
      const articles = await fetchNews(ticker);
      if (!articles.length) continue;

      const headlines     = articles.map(a => a.headline || '');
      const prevHeadlines = lastNewsHeadlines[ticker] || [];
      const newArticles   = articles.filter(a => !prevHeadlines.includes(a.headline || ''));
      const hasHistory    = prevHeadlines.length > 0;
      const verdict       = newsVerdict(articles, ticker);

      if (hasHistory && alertOnNewArticle && newArticles.length) {
        const h = newArticles[0].headline || '';
        await sendTelegram(telegramChatId,
          `📰 <b>${ticker}</b> — ${newArticles.length} new article${newArticles.length > 1 ? 's' : ''}\n"${h.slice(0, 120)}"`);
      }

      if (hasHistory && alertOnBreaking && newArticles.length) {
        const txt = newArticles.map(a => (a.headline + ' ' + (a.summary || '')).toLowerCase()).join(' ');
        const hit = BREAKING.find(w => txt.includes(w));
        if (hit) {
          const h = newArticles[0].headline || '';
          await sendTelegram(telegramChatId,
            `🚨 <b>Breaking: ${ticker}</b>\n"${h.slice(0, 130)}"`);
        }
      }

      const prevSentiment = lastNewsSentiment[ticker];
      if (hasHistory && alertOnSentimentChange && prevSentiment && prevSentiment !== verdict.sentiment) {
        const arrow = verdict.sentiment === 'Bullish' ? '📈' : verdict.sentiment === 'Bearish' ? '📉' : '➡️';
        await sendTelegram(telegramChatId,
          `${arrow} <b>${ticker}</b> sentiment: ${prevSentiment} → <b>${verdict.sentiment}</b>\n${verdict.theme}`);
      }

      updatedHeadlines[ticker] = headlines;
      updatedSentiment[ticker] = verdict.sentiment;
      changed = true;
    }

    if (changed) {
      await doc.ref.set({ lastNewsHeadlines: updatedHeadlines, lastNewsSentiment: updatedSentiment }, { merge: true });
    }
  }
});

// ── stock scout ────────────────────────────────────────────────────────────

const SCOUT_UNIVERSE = [
  'AAPL','MSFT','NVDA','TSLA','META','GOOGL','AMZN','AMD','NFLX','UBER',
  'JPM','BAC','GS','V','MA','PYPL',
  'JNJ','PFE','UNH',
  'XOM','CVX','OXY',
  'WMT','COST','NKE','MCD',
  'PLTR','SOFI','MSTR','COIN','RIVN',
  'DIS','ORCL','CRM','INTC','MU','SNOW','SHOP'
];

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const ag = gains / period, al = losses / period;
  if (al === 0) return 100;
  return +(100 - 100 / (1 + ag / al)).toFixed(1);
}

function calcATR(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period + 1) return highs[n - 1] - lows[n - 1];
  const trs = [];
  for (let i = n - period; i < n; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

async function fetchCandles(ticker) {
  try {
    const to   = Math.floor(Date.now() / 1000);
    const from = to - 35 * 86400;
    const r = await fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${to}&token=${FINNHUB_KEY}`);
    const d = await r.json();
    if (d && d.s === 'ok' && d.c && d.c.length >= 15) return d;
  } catch (_) {}
  return null;
}

function scoreStock(candles, quote, ticker) {
  const { c: closes, h: highs, l: lows, v: volumes } = candles;
  const n = closes.length;
  if (n < 21) return null;

  const price    = quote.price;
  const rsi      = calcRSI(closes);
  const atr      = calcATR(highs, lows, closes);
  const sma10    = closes.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const sma20    = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const avgVol   = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio = avgVol > 0 ? volumes[n - 1] / avgVol : 1;
  const mom5     = n >= 6 ? ((closes[n - 1] - closes[n - 6]) / closes[n - 6]) * 100 : 0;
  const atrPct   = atr / price;

  let score = 0;
  const signals = [];

  if (rsi >= 35 && rsi <= 55)      { score += 25; signals.push(`RSI ${rsi} — oversold bounce setup`); }
  else if (rsi >= 55 && rsi <= 68) { score += 15; signals.push(`RSI ${rsi} — bullish momentum range`); }
  else if (rsi < 35)               { score += 10; signals.push(`RSI ${rsi} — deeply oversold`); }

  if (price > sma10) { score += 10; signals.push('Price above 10-day SMA'); }
  if (price > sma20) { score +=  5; signals.push('Price above 20-day SMA'); }
  if (sma10 > sma20) { score +=  5; signals.push('Short-term uptrend (10 > 20 SMA)'); }

  if (volRatio >= 2.0)      { score += 20; signals.push(`Volume ${volRatio.toFixed(1)}× avg — strong interest`); }
  else if (volRatio >= 1.5) { score += 13; signals.push(`Volume ${volRatio.toFixed(1)}× avg`); }
  else if (volRatio >= 1.2) { score +=  7; signals.push('Above-average volume'); }

  if (mom5 >= 2 && mom5 <= 12)     { score += 20; signals.push(`+${mom5.toFixed(1)}% 5-day momentum`); }
  else if (mom5 >= 0.5 && mom5 < 2){ score += 10; signals.push(`+${mom5.toFixed(1)}% momentum building`); }
  else if (mom5 > 12)               { score +=  5; signals.push(`+${mom5.toFixed(1)}% — extended, caution`); }

  if (quote.changePct >= 1 && quote.changePct <= 4)      { score += 15; signals.push(`+${quote.changePct.toFixed(2)}% today`); }
  else if (quote.changePct >= 0.3 && quote.changePct < 1){ score +=  8; signals.push(`+${quote.changePct.toFixed(2)}% today`); }

  let risk = 5;
  if (atrPct > 0.05)        risk = 9;
  else if (atrPct > 0.035)  risk = 7;
  else if (atrPct > 0.025)  risk = 6;
  else if (atrPct < 0.015)  risk = 3;

  const confidence = Math.min(Math.round(score), 95);
  const slDist     = Math.max(atr * 1.5, price * 0.025);
  const entry      = +price.toFixed(2);
  const stopLoss   = +(price - slDist).toFixed(2);
  const takeProfit = +(price + slDist * 2.5).toFixed(2);

  return { ticker, score, confidence, risk, entry, stopLoss, takeProfit, signals, rsi, mom5: +mom5.toFixed(2), volRatio: +volRatio.toFixed(2) };
}

exports.checkStockScout = onSchedule({
  schedule: '0 9-16 * * 1-5',
  timeZone: 'America/New_York'
}, async () => {
  const quotePairs = await Promise.all(SCOUT_UNIVERSE.map(tk => fetchQuote(tk)));
  const quoteMap   = {};
  SCOUT_UNIVERSE.forEach((tk, i) => { if (quotePairs[i]) quoteMap[tk] = quotePairs[i]; });

  const candidates = SCOUT_UNIVERSE
    .filter(tk => quoteMap[tk] && quoteMap[tk].changePct > 0.3)
    .sort((a, b) => (quoteMap[b].changePct || 0) - (quoteMap[a].changePct || 0))
    .slice(0, 15);

  const picks = [];
  for (const ticker of candidates) {
    await new Promise(r => setTimeout(r, 350));
    const candles = await fetchCandles(ticker);
    if (!candles) continue;
    const result = scoreStock(candles, quoteMap[ticker], ticker);
    if (result && result.confidence >= 40) picks.push(result);
  }

  picks.sort((a, b) => b.score - a.score);
  const topPicks = picks.slice(0, 5);
  if (!topPicks.length) return;

  await db.collection('stockScouts').doc('latest').set({ generatedAt: Date.now(), picks: topPicks });

  const snap = await db.collection('users').get();
  for (const doc of snap.docs) {
    const data = doc.data();
    const { stockScoutEnabled, telegramChatId, scoutMinConfidence = 60, scoutMaxRisk = 7 } = data;
    if (!stockScoutEnabled || !telegramChatId) continue;

    const eligible = topPicks.filter(p => p.confidence >= scoutMinConfidence && p.risk <= scoutMaxRisk);
    if (!eligible.length) continue;

    const dt = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    let msg = `🔍 <b>Edge Tracker — Scout Picks</b>\n<i>${dt} ET</i>\n\n`;
    for (const p of eligible.slice(0, 3)) {
      const riskEmoji = p.risk <= 3 ? '🟢' : p.risk <= 6 ? '🟡' : '🔴';
      msg += `<b>${p.ticker}</b>  ${riskEmoji} Risk ${p.risk}/10\n`;
      msg += `💰 Entry: <b>$${p.entry}</b>\n`;
      msg += `🛑 Stop Loss: $${p.stopLoss}\n`;
      msg += `🎯 Take Profit: $${p.takeProfit}\n`;
      msg += `📊 Confidence: <b>${p.confidence}%</b>\n`;
      msg += `💡 ${p.signals.slice(0, 2).join(' · ')}\n\n`;
    }
    msg += `<i>Not financial advice. Always manage your risk.</i>`;
    await sendTelegram(telegramChatId, msg);
  }
});
