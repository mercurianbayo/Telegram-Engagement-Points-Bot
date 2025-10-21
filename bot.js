// Load environment variables
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const OpenAI = require('openai');

// --- Init Bot + Database ---
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const db = new Database("engagebot.db");
const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

console.log("🤖 Engage Bot running...");

// --- Create tables if not exist ---
db.prepare(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT,
  points INTEGER DEFAULT 0,
  last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
  warned INTEGER DEFAULT 0
)`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  url TEXT,
  title TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`).run();

console.log("✅ Database initialized");

// --- Helper Functions ---
function getUser(id, username) {
  let user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!user) {
    db.prepare("INSERT INTO users (id, username, points) VALUES (?, ?, 0)").run(id, username || "unknown");
    user = { id, username, points: 0, last_active: new Date(), warned: 0 };
  }
  return user;
}

function updateActivity(id) {
  db.prepare("UPDATE users SET last_active = CURRENT_TIMESTAMP, warned = 0 WHERE id = ?").run(id);
}

function addPoints(id, amount) {
  db.prepare("UPDATE users SET points = points + ? WHERE id = ?").run(amount, id);
}

function deductPoints(id, amount) {
  db.prepare("UPDATE users SET points = points - ? WHERE id = ?").run(amount, id);
}

// --- COMMANDS ---

// /start
bot.onText(/\/start/, (msg) => {
  const user = getUser(msg.from.id, msg.from.username);
  bot.sendMessage(msg.chat.id, `👋 Welcome, ${msg.from.first_name || "friend"}!\nYou have ${user.points} points.\nUse /browse to view links or /droplink to share yours.`);
});

// /profile
bot.onText(/\/profile/, (msg) => {
  const user = getUser(msg.from.id, msg.from.username);
  bot.sendMessage(msg.chat.id, `📊 Profile for @${user.username || "unknown"}\nPoints: ${user.points}\nLast active: ${user.last_active}`);
});

// /droplink <url> <title>
bot.onText(/\/droplink (.+) (.+)/, (msg, match) => {
  const url = match[1];
  const title = match[2];
  const user = getUser(msg.from.id, msg.from.username);

  const cost = 1000;
  if (user.points < cost) {
    return bot.sendMessage(msg.chat.id, `❌ Not enough points. You need ${cost} points, but you only have ${user.points}.`);
  }

  deductPoints(user.id, cost);
  db.prepare("INSERT INTO links (user_id, url, title) VALUES (?, ?, ?)").run(user.id, url, title);
  updateActivity(user.id);

  bot.sendMessage(msg.chat.id, `✅ Your link has been posted:\n\n<b>${title}</b>\n${url}`, { parse_mode: "HTML" });
});

// /browse
bot.onText(/\/browse/, (msg) => {
  const links = db.prepare("SELECT * FROM links ORDER BY created_at DESC LIMIT 10").all();
  if (!links.length) return bot.sendMessage(msg.chat.id, "No links available yet.");

  links.forEach((link) => {
    const opts = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "👍 Like +200", callback_data: `like_${link.id}` },
            { text: "💬 Comment +350", callback_data: `comment_${link.id}` },
            { text: "🔁 Repost +500", callback_data: `repost_${link.id}` },
          ],
        ],
      },
    };
    bot.sendMessage(msg.chat.id, `<b>${link.title}</b>\n${link.url}`, { parse_mode: "HTML", ...opts });
  });
});

// --- BUTTON HANDLERS ---
bot.on("callback_query", (query) => {
  const [action, linkId] = query.data.split("_");
  const user = getUser(query.from.id, query.from.username);
  const pointsMap = { like: 200, comment: 350, repost: 500 };
  const earned = pointsMap[action] || 0;

  addPoints(user.id, earned);
  updateActivity(user.id);
  bot.answerCallbackQuery(query.id, { text: `+${earned} points!` });
  bot.sendMessage(query.message.chat.id, `@${user.username || "User"} earned ${earned} points!`);
});

// --- ADMIN COMMAND ---
bot.onText(/\/stats/, (msg) => {
  if (String(msg.from.id) !== String(process.env.ADMIN_ID)) return;
  const users = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  const links = db.prepare("SELECT COUNT(*) AS count FROM links").get().count;
  const totalPoints = db.prepare("SELECT SUM(points) AS total FROM users").get().total || 0;

  bot.sendMessage(msg.chat.id, `📈 <b>Bot Stats</b>\nUsers: ${users}\nLinks: ${links}\nTotal Points: ${totalPoints}`, { parse_mode: "HTML" });
});

// --- CRON JOBS ---

// Warn inactive users after 48h
cron.schedule("0 * * * *", () => {
  const inactive = db.prepare(`
    SELECT * FROM users
    WHERE warned = 0
    AND (strftime('%s','now') - strftime('%s', last_active)) > 172800
  `).all();

  inactive.forEach((u) => {
    bot.sendMessage(u.id, "⚠️ You’ve been inactive for over 48 hours. Engage soon to avoid losing 100 points!");
    db.prepare("UPDATE users SET warned = 1 WHERE id = ?").run(u.id);
  });
});

// Penalize inactive users after 72h
cron.schedule("30 * * * *", () => {
  const penalized = db.prepare(`
    SELECT * FROM users
    WHERE (strftime('%s','now') - strftime('%s', last_active)) > 259200
  `).all();

  penalized.forEach((u) => {
    deductPoints(u.id, 100);
    bot.sendMessage(u.id, "❌ You lost 100 points due to inactivity.");
  });
});

// --- AI Conversational Handler ---
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (!text || text.startsWith("/")) return; // skip commands

  try {
    const user = getUser(msg.from.id, msg.from.username);

    const response = await ai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an AI assistant inside a Telegram engagement bot.
          Help users understand and manage their engagement points.
          Reference their points and suggest actions like liking, commenting, or reposting.`,
        },
        {
          role: "user",
          content: `@${user.username || "unknown"} has ${user.points} points. Message: ${text}`,
        },
      ],
    });

    const reply = response.choices[0].message.content;
    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("AI error:", err);
    bot.sendMessage(chatId, "⚠️ Sorry, I couldn’t respond right now. Try again later.");
  }
});
