// pages/api/telegram.js
import TelegramBot from "node-telegram-bot-api";
import { Redis } from "@upstash/redis";

export const config = {
  api: { bodyParser: false },
};

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const DEFAULT_GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;

// Upstash Redis
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

if (!TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN env");

const bot = new TelegramBot(TOKEN, { polling: false });
if (WEBHOOK_URL) bot.setWebHook(WEBHOOK_URL).catch(() => {});

// Helpers
const thbFormatter = new Intl.NumberFormat("th-TH", {
  style: "currency",
  currency: "THB",
  maximumFractionDigits: 0,
});
const formatCurrency = (amount) =>
  amount < 0 ? `-${thbFormatter.format(-amount)}` : thbFormatter.format(amount);

function parseAmount(text) {
  const value = Number(text.replace(/,/g, ""));
  return Number.isFinite(value) ? value : NaN;
}

// Redis state helpers
async function getState(chatId) {
  const key = `chat:${chatId}`;
  const data = await redis.get(key);
  if (data) return JSON.parse(data);
  const init = { members: ["loren", "rei", "jessi", "thora"], items: [], lastResult: null };
  await redis.set(key, JSON.stringify(init));
  return init;
}
async function setState(chatId, state) {
  await redis.set(`chat:${chatId}`, JSON.stringify(state));
}

// Compute settlement
function computeSettlementFromItems(members, items) {
  const pairDebts = new Map();
  const addDebt = (from, to, amount) => {
    if (amount <= 0) return;
    if (!pairDebts.has(from)) pairDebts.set(from, new Map());
    const inner = pairDebts.get(from);
    inner.set(to, (inner.get(to) || 0) + amount);
  };
  for (const item of items) {
    const participants = item.participants.length > 0 ? item.participants : members;
    const roundedShare = Math.round(item.amount / participants.length);
    for (const p of participants) if (p !== item.payer) addDebt(p, item.payer, roundedShare);
  }
  const transfers = [];
  for (const from of pairDebts.keys()) {
    const inner = pairDebts.get(from);
    for (const [to, amt] of inner.entries()) {
      const back = pairDebts.get(to)?.get(from) || 0;
      const net = amt - back;
      if (net > 0) transfers.push({ from, to, amount: net });
      if (back > 0) pairDebts.get(to).set(from, 0);
    }
  }
  const merged = new Map();
  for (const t of transfers) {
    const key = `${t.from}->${t.to}`;
    merged.set(key, (merged.get(key) || 0) + t.amount);
  }
  return Array.from(merged.entries()).map(([key, amount]) => {
    const [from, to] = key.split("->");
    return { from, to, amount };
  });
}

// Command handlers
async function replyUsage(chatId) {
  const msg = [
    "Chào! tui là một con bot chia bill. Hãy tham khảo các lệnh sau:",
    "/start - hướng dẫn",
    "/names thora,jessi,loren,rei - đặt tên 4 người",
    "/add <NgườiTrả> <SốTiền> [A,B,...|all] [ghi chú]",
    "ví dụ cho lệnh add : jessi 150 thora,loren cho_dem || jessi 150 all xe_tuktuk",
    "/chia - hiển thị ai trả cho ai và tự gửi vào group",
    "/send - gửi lại kết quả gần nhất vào group",
    "/clear - xoá dữ liệu hiện tại để tạo bill mới",
  ].join("\n");
  await bot.sendMessage(chatId, msg);
}

// Main handler
export default async function handler(req, res) {
  if (req.method === "GET") return res.status(200).json({ ok: true, msg: "webhook online" });

  if (req.method === "POST") {
    try {
      // read raw body
      let body = "";
      for await (const chunk of req) body += chunk;
      const update = JSON.parse(body);

      const chatId = update.message?.chat?.id || update.edited_message?.chat?.id;
      const text = update.message?.text || update.edited_message?.text;

      if (!chatId || !text) return res.status(200).end("ok");

      // /ping test
      if (/^\/ping\b/i.test(text)) {
        await bot.sendMessage(chatId, "pong ✔️");
        return res.status(200).end("ok");
      }

      // /start
      if (/^\/start\b/i.test(text)) {
        await replyUsage(chatId);
        return res.status(200).end("ok");
      }

      // /names
      if (/^\/names\b/i.test(text)) {
        const state = await getState(chatId);
        const match = text.match(/^\/names\b\s*(.*)$/i);
        const payload = match && match[1] ? match[1].trim() : "";
        if (!payload) {
          await bot.sendMessage(chatId, `Thành viên hiện tại: ${state.members.join(", ")}`);
          return res.status(200).end("ok");
        }
        const parts = payload
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (parts.length !== 4) {
          await bot.sendMessage(chatId, "Vui lòng nhập đúng 4 tên, ví dụ: /names An,Bình,Chi,Dũng");
          return res.status(200).end("ok");
        }
        state.members = parts;
        state.items = [];
        await setState(chatId, state);
        await bot.sendMessage(chatId, `Đã cập nhật tên: ${state.members.join(", ")}`);
        return res.status(200).end("ok");
      }

      // /add
      if (/^\/(add|spent)\b/i.test(text)) {
        const state = await getState(chatId);
        const raw = text.replace(/^\/(add|spent)\b/i, "").trim();
        const dashParts = raw
          .split(/\s*-\s*/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (dashParts.length >= 2) {
          const payer = dashParts[0];
          if (!state.members.includes(payer)) {
            await bot.sendMessage(chatId, `Tên không tồn tại trong nhóm: ${payer}`);
            return res.status(200).end("ok");
          }
          const amount = parseAmount(dashParts[1]);
          if (!Number.isFinite(amount) || amount <= 0) {
            await bot.sendMessage(chatId, "Số tiền không hợp lệ.");
            return res.status(200).end("ok");
          }
          let participants = state.members.slice();
          if (dashParts[2]) {
            const normalized = dashParts[2].replace(/^\[/, "").replace(/\]$/, "");
            if (normalized.toLowerCase() !== "all") {
              const maybe = normalized
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              const allValid = maybe.every((n) => state.members.includes(n));
              if (!allValid) {
                await bot.sendMessage(
                  chatId,
                  `Danh sách không hợp lệ. Hợp lệ: ${state.members.join(", ")}`
                );
                return res.status(200).end("ok");
              }
              participants = maybe;
            }
          }
          const note = dashParts[3] || "";
          state.items.push({ payer, amount, participants, note });
          await setState(chatId, state);
          await bot.sendMessage(
            chatId,
            `Đã ghi: ${payer} trả ${formatCurrency(amount)} cho [${participants.join(", ")}]${
              note ? ` (${note})` : ""
            }`
          );
          return res.status(200).end("ok");
        }
      }

      // /chia
      if (/^\/(chia|split)\b/i.test(text)) {
        const state = await getState(chatId);
        const transfers = computeSettlementFromItems(state.members, state.items);
        const output =
          transfers.length === 0
            ? "Chưa có khoản chi nào."
            : transfers.map((t) => `${t.from} → ${t.to}: ${formatCurrency(t.amount)}`).join("\n");
        state.lastResult = output;
        await setState(chatId, state);
        await bot.sendMessage(chatId, output);

        // Tự động gửi vào group nếu có kết quả
        if (DEFAULT_GROUP_CHAT_ID && transfers.length > 0) {
          try {
            await bot.sendMessage(
              DEFAULT_GROUP_CHAT_ID,
              `Kết quả chia bill:\n\n${state.lastResult}`
            );
            if (String(DEFAULT_GROUP_CHAT_ID) !== String(chatId)) {
              await bot.sendMessage(chatId, `Đã gửi kết quả vào group (${DEFAULT_GROUP_CHAT_ID}).`);
            }
          } catch (err) {
            await bot.sendMessage(chatId, `Không gửi được vào group. Lỗi: ${err.message}`);
          }
        }
        return res.status(200).end("ok");
      }

      // /clear
      if (/^\/(clear|reset)\b/i.test(text)) {
        const state = await getState(chatId);
        state.items = [];
        state.lastResult = null;
        await setState(chatId, state);
        await bot.sendMessage(chatId, "Đã xoá dữ liệu.");
        return res.status(200).end("ok");
      }

      // /getchatid
      if (/^\/getchatid\b/i.test(text)) {
        await bot.sendMessage(chatId, `Chat ID: ${chatId}`);
        return res.status(200).end("ok");
      }

      // /send
      if (/^\/(send|announce)\b/i.test(text)) {
        const state = await getState(chatId);
        if (!state.lastResult) {
          await bot.sendMessage(chatId, "Chưa có kết quả nào để gửi. Hãy dùng /chia trước.");
          return res.status(200).end("ok");
        }
        if (!DEFAULT_GROUP_CHAT_ID) {
          await bot.sendMessage(chatId, "Chưa cấu hình GROUP_CHAT_ID.");
          return res.status(200).end("ok");
        }
        try {
          await bot.sendMessage(DEFAULT_GROUP_CHAT_ID, `Kết quả chia bill:\n\n${state.lastResult}`);
          await bot.sendMessage(chatId, `Đã gửi kết quả vào group (${DEFAULT_GROUP_CHAT_ID}).`);
        } catch (err) {
          await bot.sendMessage(chatId, `Không gửi được vào group. Lỗi: ${err.message}`);
        }
        return res.status(200).end("ok");
      }

      return res.status(200).end("ok");
    } catch (err) {
      console.error("Webhook error:", err);
      return res.status(500).send("error");
    }
  }

  return res.status(200).end("ok");
}
