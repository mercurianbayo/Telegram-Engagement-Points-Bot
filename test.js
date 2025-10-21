require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

console.log('🤖 Bot is running...');

bot.on('message', (msg) => {
  console.log('Message received:', msg.text);
  bot.sendMessage(msg.chat.id, 'Your bot is alive! 🚀');
});

bot.on('polling_error', console.error);
