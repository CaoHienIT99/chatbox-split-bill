import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEFAULT_GROUP_CHAT_ID = process.env.GROUP_CHAT_ID; // optional

if (!TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

// In-memory session per chatId
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
  const state = chatState.get(stateId);
  return state;
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
  // Pairwise debts: debtor -> creditor -> amount (whole baht per item)
  const pairDebts = new Map(); // Map<from, Map<to, amount>>

  const addDebt = (from, to, amount) => {
    if (amount <= 0) return;
    if (!pairDebts.has(from)) pairDebts.set(from, new Map());
    const inner = pairDebts.get(from);
    inner.set(to, (inner.get(to) || 0) + amount);
  };

  for (const item of items) {
    const participants =
      item.participants && item.participants.length > 0 ? item.participants : members;
    const rawShare = item.amount / participants.length;
    const roundedShare = Math.round(rawShare); // per-item rounding to whole baht
    for (const p of participants) {
      if (p === item.payer) continue;
      addDebt(p, item.payer, roundedShare);
    }
  }

  // Net opposite directions between each pair
  const transfers = [];
  for (const from of pairDebts.keys()) {
    const inner = pairDebts.get(from);
    for (const [to, amt] of inner.entries()) {
      const back = pairDebts.get(to)?.get(from) || 0;
      const net = amt - back;
      if (net > 0) {
        transfers.push({ from, to, amount: net });
      }
      // prevent double counting by clearing the reverse once processed
      if (back > 0) {
        pairDebts.get(to).set(from, 0);
      }
    }
  }

  // Merge duplicates just in case
  const merged = new Map(); // key `${from}->${to}`
  for (const t of transfers) {
    const key = `${t.from}->${t.to}`;
    merged.set(key, (merged.get(key) || 0) + t.amount);
  }
  const mergedTransfers = Array.from(merged.entries()).map(([key, amount]) => {
    const [from, to] = key.split("->");
    return { from, to, amount };
  });

  return { transfers: mergedTransfers };
}

function formatTransfersOnly(members, items) {
  const { transfers } = computeSettlementFromItems(members, items);
  if (transfers.length === 0) return "Chưa có khoản chi nào.";
  const lines = [];
  for (const t of transfers) lines.push(`${t.from} → ${t.to}: ${formatCurrency(t.amount)}`);
  return lines.join("\n");
}

function parseAmount(text) {
  const normalized = text.replace(/,/g, "");
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
    "Chào! Bot chia bill (4 người, hỗ trợ mỗi khoản có nhóm tham gia):",
    "/start - hướng dẫn",
    "/names A,B,C,D - đặt tên 4 người (dùng dấu phẩy)",
    "/names - xem danh sách tên hiện tại",
    "/add <NgườiTrả> <SốTiền> [A,B,...|all] [ghi chú] - cú pháp nhanh",
    "/add <NgườiTrả> - <SốTiền> - <A,B,...|all> - <ghi chú> - cú pháp rõ ràng",
    "/chia - hiển thị ai trả cho ai (đã gộp) và tự động gửi vào group nếu cấu hình",
    "/clear - xoá dữ liệu hiện tại",
    "/getchatid - lấy Chat ID hiện tại",
    "/send - gửi kết quả gần nhất lên group (nếu cấu hình)",
    "Chế độ sổ chung: nếu cấu hình GROUP_CHAT_ID, mọi lệnh ở DM cũng ghi vào sổ của group này.",
  ].join("\n");
  bot.sendMessage(chatId, msg);
}

bot.onText(/^\/start\b/, (msg) => {
  const chatId = msg.chat.id;
  replyUsage(chatId);
});

bot.onText(/^\/names\b(?:\s+(.+))?$/i, (msg, match) => {
  const chatId = msg.chat.id;
  const state = getOrCreateState(chatId);
  const payload = match && match[1] ? match[1].trim() : "";
  if (!payload) {
    const current = state.members.join(", ");
    bot.sendMessage(chatId, `Thành viên hiện tại: ${current}`);
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

// /add (alias: /spent)
bot.onText(/^\/(add|spent)\b\s+(.+)$/i, (msg, match) => {
  const chatId = msg.chat.id;
  const state = getOrCreateState(chatId);
  const raw = match[2].trim();

  // Hyphen-separated form preferred
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
      bot.sendMessage(chatId, "Số tiền không hợp lệ. Ví dụ: 125000");
      return;
    }
    let participants = state.members.slice();
    if (dashParts[2]) {
      const rawList = dashParts[2].trim();
      const normalized = rawList.replace(/^\[/, "").replace(/\]$/, "");
      if (normalized.toLowerCase() === "all") {
        participants = state.members.slice();
      } else {
        const maybe = normalized
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const allValid = maybe.length > 0 && maybe.every((n) => state.members.includes(n));
        if (!allValid) {
          bot.sendMessage(
            chatId,
            `Danh sách người tham gia không hợp lệ. Tên hợp lệ: ${state.members.join(", ")}`
          );
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

  // Space-separated fallback
  const args = raw.split(/\s+/);
  if (args.length < 2) {
    bot.sendMessage(
      chatId,
      "Cú pháp: /spent <NgườiTrả> - <SốTiền> - <A,B,...> - <ghi chú>\nHoặc: /spent <NgườiTrả> <SốTiền> [A,B,...] [ghi chú]"
    );
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
    bot.sendMessage(chatId, "Số tiền không hợp lệ. Ví dụ: 125000");
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

// /chia (alias: /split) — also auto-send to group if configured
bot.onText(/^\/(chia|split)\b/i, async (msg) => {
  const chatId = msg.chat.id;
  const state = getOrCreateState(chatId);
  const { transfers } = computeSettlementFromItems(state.members, state.items);
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
        `Không gửi được vào GROUP_CHAT_ID=${targetChatId}. Lỗi: ${err?.message || err}.\n` +
          `Kiểm tra: 1) Bot đã được add vào group, 2) ID đúng (thử thêm tiền tố -100 nếu là supergroup), 3) Bot chưa bị chặn.`
      );
    }
  }
});

// /send (alias: /announce)
bot.onText(/^\/(send|announce)\b/i, async (msg) => {
  const chatId = msg.chat.id;
  const state = getOrCreateState(chatId);
  if (!state.lastResult) {
    bot.sendMessage(chatId, "Chưa có kết quả. Hãy dùng /split trước.");
    return;
  }
  const targetChatId = DEFAULT_GROUP_CHAT_ID || chatId;
  if (!DEFAULT_GROUP_CHAT_ID) {
    bot.sendMessage(chatId, "GROUP_CHAT_ID chưa được cấu hình, gửi vào chat hiện tại.");
  }
  await bot.sendMessage(targetChatId, `Kết quả chia bill:\n\n${state.lastResult}`);
  if (String(targetChatId) !== String(chatId)) {
    bot.sendMessage(chatId, "Đã gửi thông báo lên group.");
  }
});

// /clear (alias: /reset)
bot.onText(/^\/(clear|reset)\b/i, (msg) => {
  const chatId = msg.chat.id;
  const state = getOrCreateState(chatId);
  state.items = [];
  state.lastResult = null;
  bot.sendMessage(chatId, "Đã xoá dữ liệu.");
});

bot.onText(/^\/getchatid\b/i, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `Chat ID: ${chatId}`);
});

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

console.log("Bot is running...");
