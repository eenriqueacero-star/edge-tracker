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

// ── stock scout helpers ───────────────────────────────────────────────────

const SCOUT_UNIVERSE = [
  'AAPL','MSFT','NVDA','AMD','INTC','QCOM','TXN','MU','AMAT','LRCX','KLAC','MRVL','ON','SMCI','ARM','WOLF','AMBA','ENTG',
  'CRM','ADBE','NOW','SNOW','PLTR','PANW','CRWD','ZS','NET','DDOG','MDB','GTLB','CFLT','ESTC','AI','BBAI','SOUN','RXRX',
  'V','MA','PYPL','SQ','COIN','HOOD','SOFI','AFRM','NU','MSTR','UBER','LYFT','ABNB','DASH','SHOP','RBLX','SPOT','SNAP',
  'JPM','BAC','GS','MS','WFC','C','BLK','LLY','ABBV','UNH','MRK','PFE','MRNA','GILD','REGN','BIIB','EXAS',
  'XOM','CVX','OXY','COP','SLB','HAL','DVN','WMT','COST','NKE','LULU','CMG','MCD','SBUX','DPZ','TGT',
  'LMT','RTX','BA','CAT','DE','HON','RIVN','LCID','ENPH','FSLR','CHPT','DIS','NFLX','PARA',
  'IONQ','ACHR','JOBY','LUNR','RKLB','SPY','QQQ','SMH','SOXL','META','GOOGL','AMZN','TSLA','AVGO','ORCL'
];

function scoutCalcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = losses === 0 ? 100 : gains / losses;
  return 100 - 100 / (1 + rs);
}

function scoutCalcATR(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < 2) return 0;
  const trs = [];
  for (let i = Math.max(1, n - period - 1); i < n; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function scoutCalcOBVSlope(closes, volumes) {
  const n = closes.length;
  if (n < 21) return 0;
  const cl = closes.slice(-20), vl = volumes.slice(-20);
  let obv = 0;
  const arr = [0];
  for (let i = 1; i < 20; i++) {
    obv += cl[i] > cl[i-1] ? vl[i] : cl[i] < cl[i-1] ? -vl[i] : 0;
    arr.push(obv);
  }
  const avgVol = vl.reduce((a, b) => a + b, 0) / vl.length || 1;
  const norm = arr.map(v => v / avgVol);
  const xMean = 9.5, yMean = norm.reduce((a, b) => a + b, 0) / 20;
  let num = 0, den = 0;
  norm.forEach((y, x) => { num += (x - xMean) * (y - yMean); den += (x - xMean) ** 2; });
  return den ? num / den : 0;
}

function scoutCalcBBWidth(closes, period = 20) {
  if (closes.length < period) return 0;
  const sl = closes.slice(-period);
  const mean = sl.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(sl.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  return mean ? (4 * std) / mean : 0;
}

function scoutScore(candles) {
  const { c: closes, h: highs, l: lows, v: volumes } = candles;
  const n = closes.length;
  if (n < 50) return null;

  let score = 0;
  const signals = [];

  const high52 = Math.max(...closes.slice(-Math.min(252, n)));
  const priceToHigh = closes[n-1] / high52;
  if (priceToHigh >= 0.98)      { score += 25; signals.push('52wk breakout'); }
  else if (priceToHigh >= 0.95) { score += 22; signals.push('Near 52wk high'); }
  else if (priceToHigh >= 0.90) { score += 16; signals.push('Within 10% 52wk'); }
  else if (priceToHigh >= 0.80) { score += 8; }

  const obvSlope = scoutCalcOBVSlope(closes, volumes);
  if (obvSlope > 0.2)      { score += 20; signals.push('OBV accumulation'); }
  else if (obvSlope > 0.07) { score += 13; signals.push('OBV rising'); }
  else if (obvSlope > 0.02) { score += 6; }

  const sma10 = closes.slice(-10).reduce((a,b)=>a+b,0)/10;
  const sma20 = closes.slice(-20).reduce((a,b)=>a+b,0)/20;
  const sma50 = closes.slice(-50).reduce((a,b)=>a+b,0)/50;
  const price = closes[n-1];
  if (price > sma10 && sma10 > sma20 && sma20 > sma50) { score += 15; signals.push('MA stack'); }
  else if (price > sma20 && sma20 > sma50)              { score += 9;  signals.push('Bullish MAs'); }
  else if (price > sma50)                               { score += 4; }

  const rsi = scoutCalcRSI(closes);
  if (rsi >= 48 && rsi <= 65)      { score += 15; signals.push(`RSI ${rsi.toFixed(0)}`); }
  else if (rsi >= 38 && rsi < 48)  { score += 9; }
  else if (rsi > 65 && rsi <= 75)  { score += 5; }

  const avgVol20 = volumes.slice(-20).reduce((a,b)=>a+b,0)/20 || 1;
  const avgVol5  = volumes.slice(-5).reduce((a,b)=>a+b,0)/5;
  const volTrend = avgVol5 / avgVol20;
  if (volTrend >= 1.4)      { score += 15; signals.push('Volume surge'); }
  else if (volTrend >= 1.2) { score += 9;  signals.push('Rising volume'); }
  else if (volTrend >= 1.05){ score += 4; }

  const bbNow = scoutCalcBBWidth(closes);
  const bbOld = n >= 40 ? scoutCalcBBWidth(closes.slice(-40, -20)) : bbNow * 1.2;
  if (bbNow < bbOld * 0.75) { score += 10; signals.push('BB squeeze'); }

  const mom5  = ((closes[n-1] - closes[n-6])  / closes[n-6])  * 100;
  const mom20 = ((closes[n-1] - closes[n-21]) / closes[n-21]) * 100;
  if (mom5 > 1.5 && mom20 > 5) { score += 10; signals.push('Strong momentum'); }
  else if (mom20 > 3)           { score += 5;  signals.push('Momentum building'); }

  const confidence = Math.round((score / 110) * 100);
  const atr  = scoutCalcATR(highs, lows, closes);
  const atrPct = price ? (atr / price) * 100 : 2;
  const risk = Math.min(9, Math.max(1, Math.round(atrPct * 2)));
  const sl = price - 1.5 * atr;
  const tp = price + 2.5 * (price - sl);

  return { score, confidence, risk, entry: price, sl, tp, signals };
}

// ── stock scout (hourly, market hours) ────────────────────────────────────

exports.checkStockScout = onSchedule({
  schedule: '0 9-16 * * 1-5',
  timeZone: 'America/New_York'
}, async () => {
  const snap = await db.collection('users').get();

  const customTickers = new Set();
  const scoutUsers = [];
  snap.forEach(doc => {
    const data = doc.data();
    if (data.stockScoutEnabled && data.telegramChatId) {
      scoutUsers.push({ ref: doc.ref, data });
      if (data.scoutCustomTickers) {
        data.scoutCustomTickers.split(',').forEach(t => {
          const tk = t.trim().toUpperCase();
          if (tk) customTickers.add(tk);
        });
      }
    }
  });

  if (!scoutUsers.length) return;

  const universe = [...new Set([...SCOUT_UNIVERSE, ...customTickers])];
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function fetchCandles(ticker) {
    try {
      const to = Math.floor(Date.now() / 1000);
      const from = to - 90 * 86400;
      const r = await fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${to}&token=${FINNHUB_KEY}`);
      const d = await r.json();
      if (d.s === 'ok' && d.c && d.c.length >= 50) return d;
    } catch (_) {}
    return null;
  }

  const picks = [];
  for (let i = 0; i < universe.length; i++) {
    if (i > 0 && i % 8 === 0) await sleep(850);
    const ticker = universe[i];
    const candles = await fetchCandles(ticker);
    if (!candles) { await sleep(380); continue; }
    const result = scoutScore(candles);
    if (result && result.score >= 35) picks.push({ ticker, ...result });
    await sleep(380);
  }

  picks.sort((a, b) => b.score - a.score);
  const top = picks.slice(0, 8);

  await db.collection('stockScouts').doc('latest').set({
    picks: top,
    generatedAt: Date.now(),
    scannedCount: universe.length
  });

  for (const { data } of scoutUsers) {
    const minConf = data.scoutMinConfidence ?? 65;
    const maxRisk = data.scoutMaxRisk ?? 7;
    const eligible = top.filter(p => p.confidence >= minConf && p.risk <= maxRisk);
    if (!eligible.length) continue;

    let msg = `🔍 <b>Scout Picks</b> — ${eligible.length} pre-run setup${eligible.length > 1 ? 's' : ''}\n\n`;
    for (const p of eligible.slice(0, 5)) {
      const tag = p.signals.includes('52wk breakout') ? ' 🚀' : '';
      msg += `<b>${p.ticker}</b>${tag} · Conf: ${p.confidence}% · Risk: ${p.risk}/10\n`;
      msg += `  Entry $${p.entry.toFixed(2)}  SL $${p.sl.toFixed(2)}  TP $${p.tp.toFixed(2)}\n`;
      if (p.signals.length) msg += `  ${p.signals.slice(0, 3).join(' · ')}\n`;
      msg += '\n';
    }
    msg += `Scanned ${universe.length} stocks`;
    await sendTelegram(data.telegramChatId, msg);
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

// ── AI Scout System ───────────────────────────────────────────────────────

// No external AI API needed — analysis built entirely from market data

async function fetchMetrics(ticker) {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${FINNHUB_KEY}`);
    const d = await r.json();
    return d?.metric || null;
  } catch(_) { return null; }
}

async function fetchCandles90(ticker) {
  try {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 90 * 86400;
    const r = await fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${to}&token=${FINNHUB_KEY}`);
    const d = await r.json();
    return (d?.s === 'ok' && d.c?.length >= 50) ? d : null;
  } catch(_) { return null; }
}

async function fetchNews30(ticker) {
  try {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${from}&to=${to}&token=${FINNHUB_KEY}`);
    const d = await r.json();
    return Array.isArray(d) ? d.slice(0, 10) : [];
  } catch(_) { return []; }
}

function scoreNewsArticles(articles) {
  const posWords = ['earnings beat','raised guidance','new contract','partnership','fda approval','analyst upgrade','buyback','dividend increase','record revenue','beat estimates','outperform','record high'];
  const negWords = ['earnings miss','lowered guidance','lawsuit','sec investigation','ceo resign','layoffs','debt default','downgrade','recall','below estimates','bankruptcy','fraud'];
  const catalystWords = ['merger','acquisition','spin-off','buyout','takeover'];
  const text = articles.map(a => (a.headline + ' ' + (a.summary||'')).toLowerCase()).join(' ');
  let score = 0;
  posWords.forEach(w => { if (text.includes(w)) score++; });
  negWords.forEach(w => { if (text.includes(w)) score--; });
  const hasCatalyst = catalystWords.some(c => text.includes(c));
  return { score, hasCatalyst, headlines: articles.map(a => a.headline||'').filter(Boolean).slice(0, 5) };
}

function scoreTechnicalsAI(candles) {
  if (!candles?.c || candles.c.length < 50) return { score: 0, data: {} };
  const closes = candles.c, highs = candles.h, lows = candles.l, volumes = candles.v;
  const n = closes.length;
  let score = 0;
  const price = closes[n-1];
  const sma50 = closes.slice(-50).reduce((a,b)=>a+b,0)/50;
  const sma200 = n >= 200 ? closes.slice(-200).reduce((a,b)=>a+b,0)/200 : null;
  if (price > sma50) score++;
  if (sma200 && price > sma200) score++;
  if (sma200 && sma50 > sma200 && n >= 70) {
    const old50 = closes.slice(-70,-20).reduce((a,b)=>a+b,0)/50;
    if (old50 < sma200 * 0.99) score += 3;
  }
  let gains = 0, losses = 0;
  for (let i = n-14; i < n; i++) { const d = closes[i]-closes[i-1]; if(d>0) gains+=d; else losses-=d; }
  const rsi = Math.round(100 - 100/(1 + (losses===0?100:gains/losses)));
  if (rsi >= 45 && rsi <= 65) score++;
  const avgVol20 = volumes.slice(-20).reduce((a,b)=>a+b,0)/20||1;
  if (volumes.slice(-5).reduce((a,b)=>a+b,0)/5 > avgVol20*1.1) score++;
  const high52 = Math.max(...closes.slice(-Math.min(252,n)));
  const low52  = Math.min(...closes.slice(-Math.min(252,n)));
  if (price >= high52*0.85) score++;
  if (n >= 60) {
    const [p60,p40,p20,p5] = [closes[n-60],closes[n-40],closes[n-20],closes[n-5]];
    if (p60 < p40 && p40 < p20 && p20 < p5) score += 2;
  }
  const ret3m = n >= 60  ? +((price-closes[n-60])/closes[n-60]*100).toFixed(1) : 0;
  const ret6m = n >= 120 ? +((price-closes[n-120])/closes[n-120]*100).toFixed(1) : 0;
  if (ret3m > 10) { score += 1; score += 2; }
  if (ret6m > 20) score += 2;
  let atrSum = 0, atrCt = 0;
  for (let i = Math.max(1,n-14); i < n; i++) { atrSum+=Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1])); atrCt++; }
  const atr = atrCt ? atrSum/atrCt : price*0.02;
  return { score, data: { price, sma50, sma200, rsi, ret3m, ret6m, high52, low52, atr } };
}

function scoreFundamentalsAI(metrics) {
  if (!metrics) return { score: 0, data: {} };
  let score = 0;
  const rg=metrics['revenueGrowthTTMYoy']??null, eg=metrics['epsGrowth']??null;
  const gm=metrics['grossMarginTTM']??null, de=metrics['totalDebt/totalEquityAnnual']??null;
  const pe=metrics['peTTM']??null, fcf=(metrics['freeCashFlowTTM']??metrics['freeCashFlowPerShareTTM']??null);
  const roe=metrics['roeTTM']??null, tgt=metrics['targetUpside']??null, bp=metrics['buyPct']??null;
  if (rg!==null&&rg>15) score+=2; if (eg!==null&&eg>20) score+=2;
  if (gm!==null&&gm>40) score+=1; if (de!==null&&de<1.0) score+=1;
  if (pe!==null&&pe>0&&pe<35) score+=1; if (fcf!==null&&fcf>0) score+=1;
  if (roe!==null&&roe>15) score+=1; if (tgt!==null&&tgt>20) score+=2;
  if (bp!==null&&bp>60) score+=2;
  return { score, data: { revenueGrowth:rg, epsGrowth:eg, grossMargin:gm, debtEquity:de, pe, fcfPositive:fcf!==null?fcf>0:null, roe, targetUpside:tgt, buyPct:bp } };
}

function analyzeStock(stock) {
  const { ticker, price, techData, fundData, newsData, totalScore, high52, low52 } = stock;
  const atr = techData.atr || price * 0.02;
  const atrPct = +(atr / price * 100).toFixed(1);

  // ── Confidence & Risk ──────────────────────────────────────────────────
  const confidence = Math.min(10, Math.max(4, Math.round(totalScore / 28 * 10)));
  const riskScore  = Math.min(9, Math.max(1, Math.round(atrPct * 1.8)));

  // ── Trade Levels ───────────────────────────────────────────────────────
  const slDist = 1.5 * atr;
  const entry  = +price.toFixed(2);
  const sl     = +(price - slDist).toFixed(2);
  // T1: near-term (15%), T2: mid (28%), T3: 52wk-high or 42% whichever is closer
  const t1Price = +(price * 1.15).toFixed(2);
  const t1Pct   = 15;
  const t2Price = fundData.targetUpside > 20 ? +(price * (1 + fundData.targetUpside / 100)).toFixed(2) : +(price * 1.28).toFixed(2);
  const t2Pct   = +((t2Price / price - 1) * 100).toFixed(1);
  const t3Price = high52 > price * 1.35 ? +(high52 * 1.05).toFixed(2) : +(price * 1.42).toFixed(2);
  const t3Pct   = +((t3Price / price - 1) * 100).toFixed(1);
  const rr      = +(((t2Price - entry) / (entry - sl))).toFixed(1);
  const maxDown = -(slDist / price * 100).toFixed(1);
  const potUp   = t3Pct;

  // ── Catalysts (built from signals that fired) ──────────────────────────
  const catalysts = [];
  if (techData.sma200 && techData.sma50 > techData.sma200) catalysts.push('Golden cross — 50MA crossed above 200MA, a classic institutional accumulation signal');
  if (fundData.revenueGrowth > 15) catalysts.push(`Revenue growing ${fundData.revenueGrowth.toFixed(1)}% YoY — above-trend business acceleration`);
  if (fundData.targetUpside > 20) catalysts.push(`Analyst consensus target ${fundData.targetUpside.toFixed(0)}% above current price — significant upside recognized`);
  if (fundData.epsGrowth > 20) catalysts.push(`EPS growth of ${fundData.epsGrowth.toFixed(1)}% YoY demonstrating earnings leverage`);
  if (newsData.hasCatalyst) catalysts.push(`Major corporate catalyst detected — merger, acquisition, or spin-off activity`);
  if (techData.ret3m > 15) catalysts.push(`${techData.ret3m}% 3-month price appreciation outpacing the broader market`);
  if (fundData.buyPct > 70) catalysts.push(`${fundData.buyPct.toFixed(0)}% of analysts rate Buy — unusually strong Wall Street conviction`);
  if (price >= high52 * 0.97) catalysts.push('Trading at or near 52-week highs — breakout momentum with institutional support');
  while (catalysts.length < 3) catalysts.push(['Improving volume trend signals institutional accumulation','Price consolidating above key moving averages before next move','Technical structure shows higher lows — buyers defending every pullback'][catalysts.length]);

  // ── Entry Strategy ─────────────────────────────────────────────────────
  const vs50 = techData.sma50 ? +((price / techData.sma50 - 1) * 100).toFixed(1) : null;
  let entryStrategy;
  if (vs50 !== null && vs50 > 8) entryStrategy = `Wait for a 3–5% pullback to the 50-day MA (~$${techData.sma50.toFixed(2)}) for better risk/reward`;
  else if (techData.rsi > 65) entryStrategy = `RSI elevated at ${techData.rsi} — scale in on any weakness over the next 1–2 weeks`;
  else entryStrategy = `Buy at market — price and momentum aligned, RSI at healthy ${techData.rsi}`;

  // ── Stop Loss Reasoning ────────────────────────────────────────────────
  const slReasoning = techData.sma50 && sl > techData.sma50 * 0.97
    ? `Below the 50-day MA ($${techData.sma50.toFixed(2)}) — a close under this level signals trend failure`
    : `1.5× ATR below entry — gives the trade room to breathe while limiting loss to ${(-maxDown).toFixed(1)}%`;

  // ── Thesis ────────────────────────────────────────────────────────────
  const fundStr = fundData.revenueGrowth > 0 ? `Revenue growing ${fundData.revenueGrowth.toFixed(0)}% YoY with ${fundData.grossMargin > 0 ? fundData.grossMargin.toFixed(0)+'% gross margins' : 'improving margins'}.` : '';
  const techStr = `RSI at ${techData.rsi} in the momentum sweet spot${techData.sma200 && techData.sma50 > techData.sma200 ? ', golden cross confirmed' : ''}. ${techData.ret3m > 5 ? techData.ret3m+'% 3-month return' : 'Price above key moving averages'}.`;
  const analystStr = fundData.targetUpside > 20 ? ` Analysts see ${fundData.targetUpside.toFixed(0)}% further upside from here.` : '';
  const thesis = `${ticker} scores ${totalScore}/28 on our composite model — a high-conviction setup for a 6-month hold. ${fundStr} ${techStr}${analystStr}`.replace(/\s+/g, ' ').trim();

  // ── News Support ───────────────────────────────────────────────────────
  let newsSupport;
  if (newsData.score >= 3) newsSupport = 'Strong positive news flow — recent headlines reinforce the bullish setup.';
  else if (newsData.score >= 1) newsSupport = 'News sentiment slightly positive — no red flags in recent coverage.';
  else if (newsData.score === 0) newsSupport = 'News neutral — setup is driven by technicals and fundamentals, not narrative.';
  else newsSupport = 'Monitor news closely — some cautionary coverage; stop loss is critical.';

  // ── Verdict ────────────────────────────────────────────────────────────
  const verdictOptions = [
    `Score ${totalScore}/28 — one of the highest-conviction setups in this scan.`,
    `${confidence >= 8 ? 'High-conviction' : 'Solid'} risk/reward of ${rr}:1 with a ${(-maxDown).toFixed(1)}% max loss and ${t3Pct}% full target.`,
    `Technical and fundamental signals aligned — this is the kind of setup worth sizing up.`,
    `${techData.ret3m > 10 ? 'Already showing relative strength' : 'Building momentum'} with a clear invalidation level at $${sl}.`
  ];
  const verdict = verdictOptions[totalScore % verdictOptions.length];

  // ── Key Risks ─────────────────────────────────────────────────────────
  const risks = [];
  if (riskScore >= 7) risks.push('High ATR — volatile stock requiring strict position sizing');
  if (fundData.debtEquity > 1.5) risks.push('Elevated debt load could amplify downside if rates rise or growth slows');
  if (techData.rsi > 70) risks.push('RSI overbought — short-term pullback likely before next leg higher');
  if (newsData.score < 0) risks.push('Negative news sentiment — monitor headlines for further deterioration');
  risks.push('Broad market sell-off would likely pull all positions down regardless of setup quality');
  if (risks.length < 2) risks.push('Sector rotation out of this industry could stall momentum');

  return {
    thesis, catalysts: catalysts.slice(0, 3),
    entry: { price: entry, strategy: entryStrategy },
    stopLoss: { price: sl, reasoning: slReasoning },
    takeProfit: {
      target1: { price: t1Price, pct: t1Pct, reasoning: 'Near-term resistance — first profit-taking zone' },
      target2: { price: t2Price, pct: t2Pct, reasoning: fundData.targetUpside > 20 ? 'Analyst consensus price target' : 'Mid-term technical target' },
      target3: { price: t3Price, pct: t3Pct, reasoning: price >= high52 * 0.9 ? '52-week high breakout continuation' : 'Full 6-month upside target' }
    },
    riskReward: rr, confidence, riskScore,
    timeframe: confidence >= 8 ? '3-5 months' : '4-6 months',
    maxDownside: +maxDown, potentialUpside: potUp,
    verdict, newsSupport, keyRisks: risks.slice(0, 3)
  };
}

function formatScoutAlertMsg(p) {
  const t1=p.takeProfit?.target1, t2=p.takeProfit?.target2, t3=p.takeProfit?.target3;
  const entry=p.entry?.price||p.price, sl=p.stopLoss?.price||0;
  return `🎯 SCOUT PICK — EDGE TRACKER
━━━━━━━━━━━━━━━━━━━━━━━━
📌 <b>${p.ticker}</b> · $${p.price?.toFixed(2)} · ${p.timeframe||'3-6 months'}
━━━━━━━━━━━━━━━━━━━━━━━━
📝 ${p.thesis||'—'}

🚀 ${(p.catalysts||[]).slice(0,2).map(c=>`• ${c}`).join('\n')}

📊 Entry: $${(+entry).toFixed(2)} | Stop: $${(+sl).toFixed(2)} (${p.maxDownside}%)
T1: $${t1?.price?.toFixed(2)||'—'} (+${t1?.pct||'—'}%) · T2: $${t2?.price?.toFixed(2)||'—'} · T3: $${t3?.price?.toFixed(2)||'—'}

📈 R/R ${p.riskReward}:1 · Conf ${p.confidence}/10 · Risk ${p.riskScore}/10
💡 ${p.verdict||'—'} | ⚠️ ${(p.keyRisks||[]).join(', ')}`;
}

async function runScoutScan() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const usersSnap = await db.collection('users').get();
  const customTickers = new Set();
  usersSnap.forEach(doc => {
    const d = doc.data();
    if (d.scoutAlertsEnabled && d.scoutCustomTickers)
      d.scoutCustomTickers.split(',').forEach(t => { const tk=t.trim().toUpperCase(); if(tk) customTickers.add(tk); });
  });
  let universe = [...new Set([...SCOUT_UNIVERSE, ...customTickers])];
  try {
    const symResp = await fetch(`https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${FINNHUB_KEY}`);
    const symData = await symResp.json();
    if (Array.isArray(symData)) {
      const extra = symData.filter(s=>(s.type==='Common Stock'||s.type==='EQ')&&/^[A-Z]{1,5}$/.test(s.symbol)).map(s=>s.symbol);
      universe = [...new Set([...universe, ...extra.slice(0,1800)])];
    }
  } catch(_) {}
  console.log(`Scout: scanning ${universe.length} symbols`);
  const validStocks = [];
  for (let i = 0; i < Math.min(universe.length,2500); i++) {
    if (i>0&&i%8===0) await sleep(950);
    try {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${universe[i]}&token=${FINNHUB_KEY}`);
      const q = await r.json();
      if (q?.c>=5&&q.c<=2000&&q.v>500000) validStocks.push({ ticker:universe[i], price:q.c });
    } catch(_) {}
  }
  console.log(`Scout: ${validStocks.length} passed price/volume filter`);
  const scored = [];
  for (let i = 0; i < validStocks.length; i++) {
    const { ticker, price } = validStocks[i];
    if (i>0&&i%5===0) await sleep(1050);
    const [cr,mr,nr] = await Promise.allSettled([fetchCandles90(ticker), fetchMetrics(ticker), fetchNews30(ticker)]);
    const tech = scoreTechnicalsAI(cr.value);
    const fund = scoreFundamentalsAI(mr.value);
    const news = scoreNewsArticles(nr.value||[]);
    const newsScore = Math.max(0, Math.min(5, (news.score>3?2:0)+(news.hasCatalyst?3:0)));
    const total = tech.score + fund.score + newsScore;
    if (total >= 12) scored.push({ ticker, price, totalScore:total, techData:tech.data, fundData:fund.data, newsData:news, high52:tech.data.high52||price*1.1, low52:tech.data.low52||price*0.7 });
    await sleep(480);
  }
  scored.sort((a,b) => b.totalScore-a.totalScore);
  const scanRunId = Date.now();
  const picks = [];
  for (const stock of scored.slice(0, 30)) {
    const analysis = analyzeStock(stock);
    const pick = {
      ticker: stock.ticker, price: stock.price, score: stock.totalScore,
      ...analysis,
      scannedAt: admin.firestore.Timestamp.now(), status: 'active',
      headlines: stock.newsData.headlines, high52: stock.high52, low52: stock.low52, scanRunId
    };
    picks.push(pick);
    await db.collection('scoutPicks').doc(`${stock.ticker}_${scanRunId}`).set(pick);
  }
  await db.collection('scoutMeta').doc('latest').set({
    scanRunId, scannedAt:admin.firestore.Timestamp.now(),
    scannedCount:validStocks.length, qualifiedCount:scored.length,
    picksCount:picks.length,
    avgConfidence: picks.length ? +(picks.reduce((s,p)=>s+(p.confidence||0),0)/picks.length).toFixed(1) : 0
  });
  const highConf = picks.filter(p=>(p.confidence||0)>=8);
  if (highConf.length) {
    const alertUsers = [];
    usersSnap.forEach(doc=>{ const d=doc.data(); if(d.scoutAlertsEnabled&&d.telegramChatId) alertUsers.push(d); });
    for (const user of alertUsers) {
      const minConf=user.scoutNotifMinConf??8, maxRisk=user.scoutNotifMaxRisk??6;
      const eligible = highConf.filter(p=>(p.confidence||0)>=minConf&&(p.riskScore||5)<=maxRisk);
      for (const pick of eligible.slice(0,3)) { await sendTelegram(user.telegramChatId, formatScoutAlertMsg(pick)); await sleep(300); }
    }
  }
  return { scannedCount:validStocks.length, qualifiedCount:scored.length, picksCount:picks.length };
}

exports.runScoutNow = onCall(async (request) => {
  if (!request.auth) throw new Error('Unauthorized');
  return await runScoutScan();
});

exports.scoutStocks = onSchedule('every 6 hours', async () => { await runScoutScan(); });

exports.checkScoutPerformance = onSchedule('every 30 minutes', async () => {
  const picksSnap = await db.collection('scoutPicks').where('status','==','active').get();
  if (picksSnap.empty) return;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tickers = [...new Set(picksSnap.docs.map(d=>d.data().ticker))];
  const priceMap = {};
  for (const ticker of tickers) { await sleep(220); const q=await fetchQuote(ticker); if(q) priceMap[ticker]=q; }
  const usersSnap = await db.collection('users').get();
  const alertUsers = [];
  usersSnap.forEach(doc=>{ const d=doc.data(); if(d.telegramChatId&&(d.scoutAlertOnTarget1||d.scoutAlertOnStop)) alertUsers.push(d); });
  for (const pickDoc of picksSnap.docs) {
    const pick = pickDoc.data();
    const q = priceMap[pick.ticker];
    if (!q) continue;
    const price=q.price, sl=pick.stopLoss?.price, t1=pick.takeProfit?.target1?.price;
    const t2=pick.takeProfit?.target2?.price, t3=pick.takeProfit?.target3?.price;
    let newStatus='active', alertMsg=null;
    if (sl&&price<=sl) { newStatus='stopped_out'; alertMsg=`🛑 STOP HIT: ${pick.ticker} at $${price.toFixed(2)} (SL $${sl.toFixed(2)})`; }
    else if (t3&&price>=t3) { newStatus='target3_hit'; alertMsg=`🏆 TARGET 3 HIT: ${pick.ticker} at $${price.toFixed(2)}`; }
    else if (t2&&price>=t2&&pick.status!=='target2_hit') { newStatus='target2_hit'; alertMsg=`🎯 TARGET 2: ${pick.ticker} at $${price.toFixed(2)} (+${pick.takeProfit?.target2?.pct}%)`; }
    else if (t1&&price>=t1&&pick.status==='active') { newStatus='target1_hit'; alertMsg=`✅ TARGET 1: ${pick.ticker} at $${price.toFixed(2)} (+${pick.takeProfit?.target1?.pct}%)`; }
    if (newStatus!==pick.status) {
      await pickDoc.ref.update({ status:newStatus, lastChecked:admin.firestore.Timestamp.now() });
      if (alertMsg) for (const user of alertUsers) {
        if ((newStatus==='target1_hit'&&user.scoutAlertOnTarget1)||(newStatus==='stopped_out'&&user.scoutAlertOnStop)||(newStatus==='target2_hit'||newStatus==='target3_hit'))
          await sendTelegram(user.telegramChatId, alertMsg);
      }
    } else { await pickDoc.ref.update({ currentPrice:price, lastChecked:admin.firestore.Timestamp.now() }); }
  }
});
