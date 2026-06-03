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
