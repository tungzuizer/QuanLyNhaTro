/**
 * telegramBot.js - Telegram Bot cho Quản Lý Nhà Trọ LISO
 * 
 * Tính năng:
 * - Nhập số điện qua tin nhắn chat (auto-parse)
 * - Truy vấn thông tin phòng, tiền thuê, số điện
 * - Bảo mật: chỉ nhận lệnh từ Admin Chat ID đã cấu hình
 */

const TelegramBotLib = require('node-telegram-bot-api');
const TelegramBot = typeof TelegramBotLib === 'function' ? TelegramBotLib : (TelegramBotLib.TelegramBot || TelegramBotLib.default);

let botInstance = null;

let dbRef = null;

// Cho phép inject db mà không cần khởi động Telegram Bot
function setDb(db) {
  dbRef = db;
}

// ==========================================
// KHỞI ĐỘNG / TẮT BOT
// ==========================================
async function startBot(token, adminChatId, db) {
  if (botInstance) {
    try {
      await botInstance.stopPolling();
    } catch(e) {}
    botInstance = null;
  }

  if (!token || !token.trim()) return { ok: false, error: 'Chưa có Bot Token' };
  if (!adminChatId) return { ok: false, error: 'Chưa có Admin Chat ID' };

  dbRef = db;

  try {
    botInstance = new TelegramBot(token, { polling: true });

    // Xử lý tất cả tin nhắn
    botInstance.on('message', (msg) => handleMessage(msg, adminChatId));

    // Xử lý lỗi polling
    botInstance.on('polling_error', (err) => {
      console.error('❌ Telegram polling error:', err.message);
    });

    // Kiểm tra kết nối
    const me = await botInstance.getMe();
    console.log(`✅ Telegram Bot @${me.username} đang chạy (Admin ID: ${adminChatId})`);
    return { ok: true, botName: me.username, botId: me.id };
  } catch (err) {
    botInstance = null;
    console.error('❌ Không thể khởi động Telegram Bot:', err.message);
    return { ok: false, error: err.message };
  }
}

async function stopBot() {
  if (botInstance) {
    try { await botInstance.stopPolling(); } catch(e) {}
    botInstance = null;
    console.log('🔴 Telegram Bot đã dừng');
  }
}

function getBotStatus() {
  return { running: !!botInstance };
}

// ==========================================
// XỬ LÝ TIN NHẮN ĐẾN
// ==========================================
async function handleMessage(msg, adminChatId) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  // Bảo mật: chỉ xử lý lệnh từ admin
  if (String(chatId) !== String(adminChatId)) {
    await botInstance.sendMessage(chatId,
      '⛔ Xin lỗi, bạn không có quyền sử dụng bot này.\n' +
      'Bot này dành riêng cho chủ nhà trọ LISO.\n\n' +
      `🆔 Chat ID của bạn là: \`${chatId}\` (Bấm vào để copy và dán vào phần cài đặt Telegram trên web).`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (!text) return;

  // --- Điều hướng theo lệnh ---
  if (text === '/start' || text === '/help') {
    await sendHelp(chatId);
  } else if (text.startsWith('/phong ')) {
    await handlePhongCmd(chatId, text.slice(7).trim().toUpperCase());
  } else if (text === '/chuathu') {
    await handleChuaThu(chatId);
  } else if (text === '/dien') {
    await handleChuaNhapDien(chatId);
  } else if (text === '/dien15' || text === '/dien 15') {
    await handleChuaNhapDienByBillingDay(chatId, 15);
  } else if (text === '/dien30' || text === '/dien 30') {
    await handleChuaNhapDienByBillingDay(chatId, 30);
  } else if (text === '/baocao') {
    await handleBaoCao(chatId);
  } else if (text === '/sodien') {
    await handleSoDien(chatId);
  } else if (text.startsWith('/tienphong ')) {
    await handleTienPhong(chatId, text.slice(11).trim().toUpperCase());
  } else {
    // Thử parse số điện từ tin nhắn tự do
    const parsed = parseElectricReadings(text);
    if (parsed.length > 0) {
      await handleElectricInput(chatId, parsed);
    } else {
      await botInstance.sendMessage(chatId,
        '❓ Tôi không hiểu lệnh này.\n\nGõ /help để xem hướng dẫn.'
      );
    }
  }
}

// ==========================================
// HELPER: Escape ký tự đặc biệt MarkdownV2
// ==========================================
function escMd(str) {
  return String(str || '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

// ==========================================
// LỆNH /help
// ==========================================
async function sendHelp(chatId) {
  const msg =
`🏠 *Bot Quản Lý Nhà Trọ LISO*

📋 *NHẬP SỐ ĐIỆN:*
Gửi trực tiếp tin nhắn theo định dạng:
\`A101: 2500\`
\`A102 - 2640, B101: 905\`
\`phòng B201 số 1200\`

🔍 *TRUY VẤN THÔNG TIN:*
/phong A101 \\- Thông tin phòng A101
/tienphong A101 \\- Tiền phải đóng tháng này
/chuathu \\- Danh sách phòng chưa đóng tiền
/dien \\- Phòng chưa nhập số điện
/dien15 \\- Phòng chưa nhập điện đợt 15 (Giữa tháng)
/dien30 \\- Phòng chưa nhập điện đợt 30 (Cuối tháng)
/sodien \\- Xem số điện các phòng tháng này
/baocao \\- Tóm tắt tài chính tháng này
/help \\- Hướng dẫn này`;

  await botInstance.sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
}

// ==========================================
// PARSE SỐ ĐIỆN TỪ TIN NHẮN TỰ DO
// ==========================================
function parseElectricReadings(text) {
  const results = [];
  const seen = new Set();

  // Pattern 1: A101: 2500, A102-2640, B101 = 905
  const p1 = /([A-Ba-b]\d{3})\s*[:\-=]\s*(\d{3,5})/g;
  // Pattern 2: phòng A101 số 2500 hoặc phòng A101 2500
  const p2 = /ph[oòó]ng\s*([A-Ba-b]\d{3})\s+(?:s[oốố]\s*)?(\d{3,5})/gi;

  for (const pattern of [p1, p2]) {
    let m;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(text)) !== null) {
      const code = m[1].toUpperCase();
      const reading = parseInt(m[2], 10);
      if (!seen.has(code) && reading >= 100) {
        seen.add(code);
        results.push({ roomCode: code, newReading: reading });
      }
    }
  }
  return results;
}

// ==========================================
// XỬ LÝ NHẬP SỐ ĐIỆN
// ==========================================
async function handleElectricInput(chatId, readings) {
  const now = new Date();
  // Giờ Việt Nam UTC+7
  const vnNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const month = vnNow.getUTCMonth() + 1;
  const year = vnNow.getUTCFullYear();

  const results = [];

  for (const { roomCode, newReading } of readings) {
    try {
      // Tìm phòng theo mã
      const room = await dbRef.prepare(
        "SELECT id, room_code FROM rooms WHERE UPPER(room_code) = ?"
      ).get(roomCode.toUpperCase());

      if (!room) {
        results.push({ roomCode, status: '❌', msg: 'Không tìm thấy phòng' });
        continue;
      }

      // Lấy chỉ số cũ (tháng trước)
      const prevMonth = month === 1 ? 12 : month - 1;
      const prevYear = month === 1 ? year - 1 : year;
      const prevReading = await dbRef.prepare(
        "SELECT new_reading FROM electricity_readings WHERE room_id = ? AND year = ? AND month = ? ORDER BY created_at DESC LIMIT 1"
      ).get(room.id, prevYear, prevMonth);
      const oldReading = prevReading ? prevReading.new_reading : 0;

      if (newReading < oldReading) {
        results.push({ roomCode, status: '⚠️', msg: `Chỉ số mới (${newReading}) < chỉ số cũ (${oldReading})` });
        continue;
      }

      const consumption = newReading - oldReading;
      const priceRow = await dbRef.prepare("SELECT value FROM settings WHERE key = 'electricity_price'").get();
      const price = parseFloat(priceRow?.value) || 3500;
      const cost = consumption * price;

      // Upsert vào electricity_readings
      const existing = await dbRef.prepare(
        "SELECT id FROM electricity_readings WHERE room_id = ? AND year = ? AND month = ?"
      ).get(room.id, year, month);

      if (existing) {
        await dbRef.prepare(
          "UPDATE electricity_readings SET new_reading = ?, consumption = ?, total_cost = ? WHERE id = ?"
        ).run(newReading, consumption, cost, existing.id);
      } else {
        await dbRef.prepare(
          "INSERT INTO electricity_readings (room_id, year, month, old_reading, new_reading, consumption, unit_price, total_cost) VALUES (?,?,?,?,?,?,?,?)"
        ).run(room.id, year, month, oldReading, newReading, consumption, price, cost);
      }

      const costStr = cost.toLocaleString('vi-VN');
      results.push({ roomCode, status: '✅', msg: `${oldReading} → ${newReading} (${consumption} kWh = ${costStr}đ)` });

    } catch (err) {
      console.error('Telegram elec error:', err);
      results.push({ roomCode, status: '❌', msg: 'Lỗi hệ thống: ' + err.message });
    }
  }

  // Tạo tin nhắn phản hồi
  const now2 = new Date();
  const vnNow2 = new Date(now2.getTime() + 7 * 60 * 60 * 1000);
  const month2 = vnNow2.getUTCMonth() + 1;
  const year2 = vnNow2.getUTCFullYear();

  let reply = `⚡ *Cập nhật số điện tháng ${month2}/${year2}*\n\n`;
  for (const r of results) {
    reply += `${r.status} Phòng *${escMd(r.roomCode)}*: ${escMd(r.msg)}\n`;
  }
  reply += `\n_Đã xử lý ${results.length} phòng_`;

  await botInstance.sendMessage(chatId, reply, { parse_mode: 'MarkdownV2' });
}

// ==========================================
// LỆNH /phong [mã phòng]
// ==========================================
async function handlePhongCmd(chatId, roomCode) {
  try {
    const room = await dbRef.prepare(`
      SELECT r.*, 
        (SELECT STRING_AGG(t.full_name, ', ') FROM tenants t WHERE t.room_id = r.id) as tenant_names,
        (SELECT STRING_AGG(t.phone, ', ') FROM tenants t WHERE t.room_id = r.id) as tenant_phones
      FROM rooms r WHERE UPPER(r.room_code) = ?
    `).get(roomCode);

    if (!room) {
      await botInstance.sendMessage(chatId, `❌ Không tìm thấy phòng *${escMd(roomCode)}*`, { parse_mode: 'MarkdownV2' });
      return;
    }

    const statusEmoji = room.status === 'occupied' ? '🟠 Đang thuê' : room.status === 'vacant' ? '🟢 Trống' : '🔴 Sửa chữa';
    const price = parseInt(room.rent_price || 0).toLocaleString('vi-VN');
    const deposit = parseInt(room.deposit || 0).toLocaleString('vi-VN');

    let reply = `🔑 *Phòng ${escMd(room.room_code)}*\n\n`;
    reply += `📌 Trạng thái: ${escMd(statusEmoji)}\n`;
    reply += `💰 Giá thuê: ${escMd(price)}đ/tháng\n`;
    reply += `🏦 Đặt cọc: ${escMd(deposit)}đ\n`;
    reply += `👥 Số người: ${escMd(String(room.member_count || 0))}\n`;
    reply += `📅 Đợt thu: Ngày ${escMd(String(room.billing_day || 30))}\n`;

    if (room.tenant_names) {
      reply += `\n👤 *Người thuê:* ${escMd(room.tenant_names)}\n`;
      if (room.tenant_phones) {
        reply += `📞 SĐT: ${escMd(room.tenant_phones)}\n`;
      }
    }

    await botInstance.sendMessage(chatId, reply, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error(err);
    await botInstance.sendMessage(chatId, '❌ Lỗi khi tra cứu phòng');
  }
}

// ==========================================
// LỆNH /tienphong [mã phòng]
// ==========================================
async function handleTienPhong(chatId, roomCode) {
  try {
    const now = new Date();
    const vnNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const month = vnNow.getUTCMonth() + 1;
    const year = vnNow.getUTCFullYear();

    const row = await dbRef.prepare(`
      SELECT r.room_code, r.rent_price, r.billing_day,
        COALESCE(p.total_amount, 0) as total_amount,
        p.is_paid,
        p.paid_at,
        COALESCE(p.electricity_amount, e.total_cost, 0) as electricity_amount,
        COALESCE(p.tenant_name, STRING_AGG(t.full_name, ', ')) as tenant_name
      FROM rooms r
      LEFT JOIN tenants t ON t.room_id = r.id
      LEFT JOIN electricity_readings e ON e.room_id = r.id AND e.year = ? AND e.month = ?
      LEFT JOIN rent_payments p ON p.room_id = r.id AND p.year = ? AND p.month = ?
      WHERE UPPER(r.room_code) = ?
      GROUP BY r.id, p.id, e.id
    `).get(year, month, year, month, roomCode);

    if (!row) {
      await botInstance.sendMessage(chatId, `❌ Không tìm thấy phòng *${escMd(roomCode)}*`, { parse_mode: 'MarkdownV2' });
      return;
    }

    const isPaid = row.is_paid === 1;
    const statusIcon = isPaid ? '✅ Đã đóng' : '⏳ Chưa đóng';
    const total = parseInt(row.total_amount || row.rent_price || 0).toLocaleString('vi-VN');
    const elec = parseInt(row.electricity_amount || 0).toLocaleString('vi-VN');
    const rent = parseInt(row.rent_price || 0).toLocaleString('vi-VN');

    let reply = `💰 *Tiền phòng ${escMd(row.room_code)} \\- tháng ${month}/${year}*\n\n`;
    reply += `👤 Người thuê: ${escMd(row.tenant_name || 'Chưa có')}\n`;
    reply += `💵 Tiền thuê: ${escMd(rent)}đ\n`;
    reply += `⚡ Tiền điện: ${escMd(elec)}đ\n`;
    reply += `💳 Tổng cộng: *${escMd(total)}đ*\n`;
    reply += `📊 Trạng thái: ${escMd(statusIcon)}\n`;
    if (isPaid && row.paid_at) {
      const paidDate = new Date(row.paid_at);
      reply += `🗓️ Đóng lúc: ${escMd(paidDate.toLocaleDateString('vi-VN'))}\n`;
    }

    await botInstance.sendMessage(chatId, reply, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error(err);
    await botInstance.sendMessage(chatId, '❌ Lỗi khi tra cứu tiền phòng');
  }
}

// ==========================================
// LỆNH /chuathu - Phòng chưa đóng tiền
// ==========================================
async function handleChuaThu(chatId) {
  try {
    const now = new Date();
    const vnNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const month = vnNow.getUTCMonth() + 1;
    const year = vnNow.getUTCFullYear();

    const rows = await dbRef.prepare(`
      SELECT r.room_code, r.billing_day,
        COALESCE(p.total_amount, r.rent_price) as total_amount,
        p.is_paid,
        COALESCE(p.tenant_name, STRING_AGG(t.full_name, ', ')) as tenant_name
      FROM rooms r
      LEFT JOIN tenants t ON t.room_id = r.id
      LEFT JOIN rent_payments p ON p.room_id = r.id AND p.year = ? AND p.month = ?
      WHERE r.status = 'occupied' AND (p.is_paid IS NULL OR p.is_paid = 0)
      GROUP BY r.id, p.id
      ORDER BY r.zone ASC, r.room_code ASC
    `).all(year, month);

    if (rows.length === 0) {
      await botInstance.sendMessage(chatId,
        `✅ Tuyệt vời\\! Tất cả các phòng đã đóng tiền tháng ${month}/${year}\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    let reply = `⏳ *Phòng chưa đóng tiền \\- tháng ${month}/${year}*\n`;
    reply += `_Tổng: ${rows.length} phòng_\n\n`;

    for (const r of rows) {
      const amount = parseInt(r.total_amount || 0).toLocaleString('vi-VN');
      const tenant = r.tenant_name || 'Chưa có tên';
      reply += `🔑 *${escMd(r.room_code)}* \\- ${escMd(tenant)} \\- ${escMd(amount)}đ\n`;
    }

    await botInstance.sendMessage(chatId, reply, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error(err);
    await botInstance.sendMessage(chatId, '❌ Lỗi khi lấy danh sách');
  }
}

// ==========================================
// LỆNH /dien - Phòng chưa nhập số điện
// ==========================================
async function handleChuaNhapDien(chatId) {
  try {
    const now = new Date();
    const vnNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const month = vnNow.getUTCMonth() + 1;
    const year = vnNow.getUTCFullYear();

    // Lấy tổng số phòng đang thuê
    const totalRow = await dbRef.prepare(`
      SELECT COUNT(*) as cnt FROM rooms WHERE status = 'occupied'
    `).get();
    const totalRooms = totalRow ? totalRow.cnt : 0;

    const rows = await dbRef.prepare(`
      SELECT r.room_code
      FROM rooms r
      WHERE r.status = 'occupied'
        AND r.id NOT IN (
          SELECT room_id FROM electricity_readings WHERE year = ? AND month = ?
        )
      ORDER BY r.zone ASC, r.room_code ASC
    `).all(year, month);

    let reply = `⚡ *Chưa nhập điện tháng ${month}/${year}*\n`;
    reply += `🏠 Tổng số phòng đang thuê: *${totalRooms}* phòng\n`;

    if (rows.length === 0) {
      reply += `✅ Đã nhập số điện cho tất cả phòng tháng ${month}/${year}\\.`;
      await botInstance.sendMessage(chatId, reply, { parse_mode: 'MarkdownV2' });
      return;
    }

    const codes = rows.map(r => r.room_code).join(', ');
    reply += `⚠️ Chưa nhập điện: *${rows.length}/${totalRooms}* phòng còn thiếu:\n\n`;
    reply += escMd(codes);
    reply += `\n\n💡 _Gửi theo dạng: \`A101: 2500\` để nhập_`;

    await botInstance.sendMessage(chatId, reply, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error(err);
    await botInstance.sendMessage(chatId, '❌ Lỗi khi lấy danh sách điện');
  }
}

// ==========================================
// LỆNH /dien15 hoặc /dien30 - Phòng chưa nhập số điện theo đợt
// ==========================================
async function handleChuaNhapDienByBillingDay(chatId, billingDay) {
  try {
    const now = new Date();
    const vnNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const month = vnNow.getUTCMonth() + 1;
    const year = vnNow.getUTCFullYear();

    // Lấy tổng số phòng đang thuê của đợt này
    const totalRow = await dbRef.prepare(`
      SELECT COUNT(*) as cnt 
      FROM rooms 
      WHERE status = 'occupied' AND COALESCE(billing_day, 30) = ?
    `).get(billingDay);
    const totalRooms = totalRow ? totalRow.cnt : 0;

    // Lấy danh sách phòng chưa nhập điện của đợt này
    const rows = await dbRef.prepare(`
      SELECT r.room_code
      FROM rooms r
      WHERE r.status = 'occupied'
        AND COALESCE(r.billing_day, 30) = ?
        AND r.id NOT IN (
          SELECT room_id FROM electricity_readings WHERE year = ? AND month = ?
        )
      ORDER BY r.zone ASC, r.room_code ASC
    `).all(billingDay, year, month);

    let reply = `⚡ *Chưa nhập điện đợt ${billingDay} tháng ${month}/${year}*\n`;
    reply += `🏠 Tổng số phòng đang thuê đợt này: *${totalRooms}* phòng\n`;

    if (rows.length === 0) {
      reply += `✅ Đã nhập số điện cho tất cả phòng đợt ${billingDay} tháng ${month}/${year}\\.`;
      await botInstance.sendMessage(chatId, reply, { parse_mode: 'MarkdownV2' });
      return;
    }

    const codes = rows.map(r => r.room_code).join(', ');
    reply += `⚠️ Chưa nhập điện: *${rows.length}/${totalRooms}* phòng còn thiếu:\n\n`;
    reply += escMd(codes);
    reply += `\n\n💡 _Gửi theo dạng: \`A101: 2500\` để nhập_`;

    await botInstance.sendMessage(chatId, reply, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error(err);
    await botInstance.sendMessage(chatId, `❌ Lỗi khi lấy danh sách điện đợt ${billingDay}`);
  }
}

// ==========================================
// LỆNH /baocao - Báo cáo tổng hợp
// ==========================================
async function handleBaoCao(chatId) {
  try {
    const now = new Date();
    const vnNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const month = vnNow.getUTCMonth() + 1;
    const year = vnNow.getUTCFullYear();

    // Thống kê phòng
    const roomStats = await dbRef.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'occupied' THEN 1 ELSE 0 END) as occupied,
        SUM(CASE WHEN status = 'vacant' THEN 1 ELSE 0 END) as vacant
      FROM rooms
    `).get();

    // Thống kê thu tiền tháng này
    const payStats = await dbRef.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN is_paid = 1 THEN 1 ELSE 0 END) as paid,
        SUM(CASE WHEN is_paid = 1 THEN total_amount ELSE 0 END) as collected
      FROM rent_payments WHERE year = ? AND month = ?
    `).get(year, month);

    // Số phòng chưa nhập điện
    const missingElec = await dbRef.prepare(`
      SELECT COUNT(*) as cnt FROM rooms 
      WHERE status = 'occupied' AND id NOT IN (
        SELECT room_id FROM electricity_readings WHERE year = ? AND month = ?
      )
    `).get(year, month);

    const collected = parseInt(payStats?.collected || 0).toLocaleString('vi-VN');
    const paidCount = payStats?.paid || 0;
    const totalPay = payStats?.total || 0;

    let reply = `📊 *Báo cáo tháng ${month}/${year}*\n\n`;
    reply += `🏠 Tổng phòng: *${escMd(String(roomStats.total))}* \\(${escMd(String(roomStats.occupied))} thuê, ${escMd(String(roomStats.vacant))} trống\\)\n`;
    reply += `💰 Thu tiền: *${paidCount}/${totalPay}* phòng \\- Tổng ${escMd(collected)}đ\n`;
    reply += `⚡ Chưa nhập điện: *${escMd(String(missingElec.cnt))}* phòng\n`;
    if (missingElec.cnt > 0) {
      reply += `\n💡 Gõ /dien để xem danh sách phòng chưa nhập`;
    }

    await botInstance.sendMessage(chatId, reply, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error(err);
    await botInstance.sendMessage(chatId, '❌ Lỗi khi tạo báo cáo');
  }
}

// ==========================================
// LỆNH /sodien - Xem số điện của từng phòng
// ==========================================
async function handleSoDien(chatId) {
  try {
    const now = new Date();
    const vnNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const month = vnNow.getUTCMonth() + 1;
    const year = vnNow.getUTCFullYear();

    const rows = await dbRef.prepare(`
      SELECT r.room_code, e.new_reading, e.consumption
      FROM rooms r
      LEFT JOIN electricity_readings e ON e.room_id = r.id AND e.year = ? AND e.month = ?
      WHERE r.status = 'occupied'
      ORDER BY r.zone ASC, r.room_code ASC
    `).all(year, month);

    if (rows.length === 0) {
      await botInstance.sendMessage(chatId, `📭 Không có phòng nào đang thuê để hiển thị số điện.`);
      return;
    }

    let reply = `⚡ *Số điện các phòng tháng ${month}/${year}*\n\n`;
    for (const r of rows) {
      if (r.new_reading !== null) {
        reply += `🔑 *${escMd(r.room_code)}*: ${escMd(String(r.new_reading))} kWh \\(dùng ${escMd(String(r.consumption))} kWh\\)\n`;
      } else {
        reply += `🔑 *${escMd(r.room_code)}*: _Chưa nhập_\n`;
      }
    }

    await botInstance.sendMessage(chatId, reply, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error(err);
    await botInstance.sendMessage(chatId, '❌ Lỗi khi lấy danh sách số điện các phòng');
  }
}

async function sendDirectMessage(chatId, message, options = {}) {
  if (!botInstance) {
    throw new Error('Telegram Bot chưa kết nối.');
  }
  return await botInstance.sendMessage(chatId, message, options);
}

async function executeCommand(text) {
  if (!dbRef) {
    return { replyText: '❌ Hệ thống chưa kết nối cơ sở dữ liệu. Vui lòng thử lại sau vài giây.', parseMode: '' };
  }

  let replyText = '';
  let parseMode = '';

  const originalBotInstance = botInstance;
  const mockBotInstance = {
    sendMessage: async (chatId, message, options) => {
      replyText = message;
      parseMode = options?.parse_mode || '';
      return { message_id: 0 };
    }
  };

  botInstance = mockBotInstance;
  try {
    const fakeMsg = {
      chat: { id: 'admin_web' },
      text: text
    };
    await handleMessage(fakeMsg, 'admin_web');
  } catch (err) {
    console.error('Lỗi khi giả lập chạy lệnh bot:', err);
    replyText = '❌ Lỗi hệ thống: ' + err.message;
  } finally {
    botInstance = originalBotInstance;
  }

  return { replyText, parseMode };
}

module.exports = { startBot, stopBot, getBotStatus, sendDirectMessage, escMd, executeCommand, setDb };
