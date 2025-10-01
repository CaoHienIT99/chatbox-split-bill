import TelegramBot from "node-telegram-bot-api";

// Environment
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEFAULT_GROUP_CHAT_ID = process.env.GROUP_CHAT_ID; // optional
const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g. https://your-app.vercel.app/api/telegram

if (!TOKEN) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN env");
}

// Single bot instance per Lambda cold start
const bot = new TelegramBot(TOKEN, { polling: false });

// Attempt to set webhook on cold start (idempotent)
if (WEBHOOK_URL) {
  bot.setWebHook(WEBHOOK_URL).catch(() => {});
}

// Shared in-memory state (cold start scoped)
const chatState = new Map();

function getOrCreateState(chatId) {
  const stateId = DEFAULT_GROUP_CHAT_ID || chatId;
  if (!chatState.has(stateId)) {
    chatState.set(stateId, {
      members: ["loren", "rei", "jessi", "thora"],
      items: [],
      lastResult: null,
    });
  }
  return chatState.get(stateId);
}

const thbFormatter = new Intl.NumberFormat("th-TH", {
  style: "currency",
  currency: "THB",
  maximumFractionDigits: 0,
});

function formatCurrency(amount) {
  const sign = amount < 0 ? -1 : 1;
  const value = Math.abs(amount);
  const formatted = thbFormatter.format(value);
  return sign < 0 ? `-${formatted}` : formatted;
}

function computeSettlementFromItems(members, items) {
  const pairDebts = new Map();
  const addDebt = (from, to, amount) => {
    if (amount <= 0) return;
    if (!pairDebts.has(from)) pairDebts.set(from, new Map());
    const inner = pairDebts.get(from);
    inner.set(to, (inner.get(to) || 0) + amount);
  };
  for (const item of items) {
    const participants =
      item.participants && item.participants.length > 0 ? item.participants : members;
    const roundedShare = Math.round(item.amount / participants.length);
    for (const p of participants) {
      if (p === item.payer) continue;
      addDebt(p, item.payer, roundedShare);
    }
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

function formatTransfersOnly(members, items) {
  const transfers = computeSettlementFromItems(members, items);
  if (transfers.length === 0) return "Chưa có khoản chi nào.";
  return transfers.map((t) => `${t.from} → ${t.to}: ${formatCurrency(t.amount)}`).join("\n");
}

function parseAmount(text) {
  const normalized = String(text).replace(/,/g, "");
  const value = Number(normalized);
  if (Number.isFinite(value)) return value;
  return NaN;
}

function ensureMember(state, name) {
  if (!state.members.includes(name)) {
    throw new Error(`Tên không tồn tại trong nhóm: ${name}. Dùng /names để xem/cập nhật.`);
  }
}

function replyUsage(chatId) {
  const msg = [
    "Chào! Bot chia bill (webhook). Các lệnh:",
    "/start - hướng dẫn",
    "/names A,B,C,D - đặt tên 4 người",
    "/add <NgườiTrả> <SốTiền> [A,B,...|all] [ghi chú] - nhanh",
    "/add <NgườiTrả> - <SốTiền> - <A,B,...|all> - <ghi chú> - rõ ràng",
    "/chia - hiển thị ai trả cho ai và tự gửi vào group nếu cấu hình",
    "/clear - xoá dữ liệu hiện tại",
    "/getchatid - lấy Chat ID hiện tại",
    "/send - gửi kết quả gần nhất lên group",
    "Chế độ sổ chung: nếu có GROUP_CHAT_ID, lệnh ở DM cũng ghi vào sổ của group.",
  ].join("\n");
  bot.sendMessage(chatId, msg);
}

// Command wiring (same as src/bot.js, condensed)
bot.onText(/^\/start\b/, (msg) => replyUsage(msg.chat.id));

bot.onText(/^\/names\b(?:\s+(.+))?$/i, (msg, match) => {
  const chatId = msg.chat.id;
  const state = getOrCreateState(chatId);
  const payload = match && match[1] ? match[1].trim() : "";
  if (!payload) {
    bot.sendMessage(chatId, `Thành viên hiện tại: ${state.members.join(", ")}`);
    return;
  }
  const parts = payload
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length !== 4) {
    bot.sendMessage(chatId, "Vui lòng nhập đúng 4 tên, ví dụ: /names An,Bình,Chi,Dũng");
    return;
  }
  state.members = parts;
  state.items = [];
  bot.sendMessage(chatId, `Đã cập nhật tên: ${state.members.join(", ")}`);
});

bot.onText(/^\/(add|spent)\b\s+(.+)$/i, (msg, match) => {
  const chatId = msg.chat.id;
  const state = getOrCreateState(chatId);
  const raw = match[2].trim();

  const dashParts = raw
    .split(/\s*-\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (dashParts.length >= 2) {
    const payer = dashParts[0];
    try {
      ensureMember(state, payer);
    } catch (e) {
      bot.sendMessage(chatId, e.message);
      return;
    }
    const amount = parseAmount(dashParts[1]);
    if (!Number.isFinite(amount) || amount <= 0) {
      bot.sendMessage(chatId, "Số tiền không hợp lệ.");
      return;
    }
    let participants = state.members.slice();
    if (dashParts[2]) {
      const normalized = dashParts[2].replace(/^\[/, "").replace(/\]$/, "");
      if (normalized.toLowerCase() !== "all") {
        const maybe = normalized
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const allValid = maybe.length > 0 && maybe.every((n) => state.members.includes(n));
        if (!allValid) {
          bot.sendMessage(chatId, `Danh sách không hợp lệ. Hợp lệ: ${state.members.join(", ")}`);
          return;
        }
        participants = maybe;
      }
    }
    const note = dashParts[3] || "";
    state.items.push({ payer, amount, participants, note });
    bot.sendMessage(
      chatId,
      `Đã ghi: ${payer} trả ${formatCurrency(amount)} cho [${participants.join(", ")}]${
        note ? ` (${note})` : ""
      }`
    );
    return;
  }

  const args = raw.split(/\s+/);
  if (args.length < 2) {
    bot.sendMessage(chatId, "Cú pháp: /add <NgườiTrả> - <SốTiền> - <A,B,...|all> - <ghi chú>");
    return;
  }
  const payer = args[0];
  try {
    ensureMember(state, payer);
  } catch (e) {
    bot.sendMessage(chatId, e.message);
    return;
  }
  const amount = parseAmount(args[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    bot.sendMessage(chatId, "Số tiền không hợp lệ.");
    return;
  }
  let participants = state.members.slice();
  let noteStartIdx = 2;
  if (args[2]) {
    const csv = args[2].replace(/^\[/, "").replace(/\]$/, "");
    if (csv.toLowerCase() === "all") {
      participants = state.members.slice();
      noteStartIdx = 3;
    } else {
      const maybe = csv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const allValid = maybe.length > 0 && maybe.every((n) => state.members.includes(n));
      if (allValid) {
        participants = maybe;
        noteStartIdx = 3;
      }
    }
  }
  const note = args.slice(noteStartIdx).join(" ");
  state.items.push({ payer, amount, participants, note });
  bot.sendMessage(
    chatId,
    `Đã ghi: ${payer} trả ${formatCurrency(amount)} cho [${participants.join(", ")}]${
      note ? ` (${note})` : ""
    }`
  );
});

bot.onText(/^\/(chia|split)\b/i, async (msg) => {
  const chatId = msg.chat.id;
  const state = getOrCreateState(chatId);
  const transfers = computeSettlementFromItems(state.members, state.items);
  const output =
    transfers.length === 0
      ? "Chưa có khoản chi nào."
      : transfers.map((t) => `${t.from} → ${t.to}: ${formatCurrency(t.amount)}`).join("\n");
  state.lastResult = output;
  await bot.sendMessage(chatId, output);
  const targetChatId = DEFAULT_GROUP_CHAT_ID || null;
  if (targetChatId && transfers.length > 0) {
    try {
      await bot.sendMessage(targetChatId, `Kết quả chia bill:\n\n${state.lastResult}`);
      if (String(targetChatId) !== String(chatId)) {
        bot.sendMessage(chatId, `Đã gửi kết quả vào group (${targetChatId}).`);
      }
    } catch (err) {
      bot.sendMessage(
        chatId,
        `Không gửi được vào GROUP_CHAT_ID=${targetChatId}. Lỗi: ${err?.message || err}`
      );
    }
  }
});

bot.onText(/^\/(clear|reset)\b/i, (msg) => {
  const chatId = msg.chat.id;
  const state = getOrCreateState(chatId);
  state.items = [];
  state.lastResult = null;
  bot.sendMessage(chatId, "Đã xoá dữ liệu.");
});

bot.onText(/^\/getchatid\b/i, (msg) => {
  bot.sendMessage(msg.chat.id, `Chat ID: ${msg.chat.id}`);
});

export default async function handler(req, res) {
  if (req.method === "POST") {
    try {
      await bot.processUpdate(req.body);
      res.status(200).send("ok");
    } catch (err) {
      res.status(500).send(err?.message || "error");
    }
    return;
  }
  res.status(200).send("ok");
}
