const { onRequest } = require('firebase-functions/v2/https');

const TOKEN = '8793038031:AAF2Zwdm9JZtDWZ7zmR8b9ntqVThUq4txpo';
const API   = `https://api.telegram.org/bot${TOKEN}`;

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
