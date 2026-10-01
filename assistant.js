let dbRef = null;

function setDb(db) {
  dbRef = db;
}

function escMd(str) {
  return String(str || '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function parseElectricReadings(text) {
  const results = [];
  const seen = new Set();

  const p1 = /([A-Ba-b]\d{3})\s*[:\-=]\s*(\d{3,5})/g;
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

async function handleElectricInput(readings) {
  const now = new Date();
  const vnNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const month = vnNow.getUTCMonth() + 1;
  const year = vnNow.getUTCFullYear();

  const results = [];

  for (const { roomCode, newReading } of readings) {
    try {
      const room = await dbRef.prepare(
        "SELECT id, room_code FROM rooms WHERE UPPER(room_code) = ?"
      ).get(roomCode.toUpperCase());

      if (!room) {
        results.push({ roomCode, status: '❌', msg: 'Không tìm thấy phòng' });
        continue;
      }

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
      console.error('Assistant elec error:', err);
      results.push({ roomCode, status: '❌', msg: 'Lỗi hệ thống: ' + err.message });
    }
  }

  const now2 = new Date();
  const vnNow2 = new Date(now2.getTime() + 7 * 60 * 60 * 1000);
  const month2 = vnNow2.getUTCMonth() + 1;
  const year2 = vnNow2.getUTCFullYear();

  let reply = `⚡ *Cập nhật số điện tháng ${month2}/${year2}*\n\n`;
  for (const r of results) {
    reply += `${r.status} Phòng *${escMd(r.roomCode)}*: ${escMd(r.msg)}\n`;
  }
  reply += `\n_Đã xử lý ${results.length} phòng_`;

  return { replyText: reply, parseMode: 'MarkdownV2' };
}

async function handleHelp() {
  const msg =
`🏠 *Trợ Lý LISO*

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

  return { replyText: msg, parseMode: 'MarkdownV2' };
}

async function handlePhongCmd(roomCode) {
  try {
    const room = await dbRef.prepare(`
      SELECT r.*,
        (SELECT STRING_AGG(t.full_name, ', ') FROM tenants t WHERE t.room_id = r.id) as tenant_names,
        (SELECT STRING_AGG(t.phone, ', ') FROM tenants t WHERE t.room_id = r.id) as tenant_phones
      FROM rooms r WHERE UPPER(r.room_code) = ?
    `).get(roomCode);

    if (!room) {
      return { replyText: `❌ Không tìm thấy phòng *${escMd(roomCode)}*`, parseMode: 'MarkdownV2' };
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

    return { replyText: reply, parseMode: 'MarkdownV2' };
  } catch (err) {
    console.error(err);
    return { replyText: '❌ Lỗi khi tra cứu phòng', parseMode: '' };
  }
}

async function handleTienPhong(roomCode) {
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
      return { replyText: `❌ Không tìm thấy phòng *${escMd(roomCode)}*`, parseMode: 'MarkdownV2' };
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

    return { replyText: reply, parseMode: 'MarkdownV2' };
  } catch (err) {
    console.error(err);
    return { replyText: '❌ Lỗi khi tra cứu tiền phòng', parseMode: '' };
  }
}

async function handleChuaThu() {
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
      return {
        replyText: `✅ Tuyệt vời\\! Tất cả các phòng đã đóng tiền tháng ${month}/${year}\\.`,
        parseMode: 'MarkdownV2'
      };
    }

    let reply = `⏳ *Phòng chưa đóng tiền \\- tháng ${month}/${year}*\n`;
    reply += `_Tổng: ${rows.length} phòng_\n\n`;

    for (const r of rows) {
      const amount = parseInt(r.total_amount || 0).toLocaleString('vi-VN');
      const tenant = r.tenant_name || 'Chưa có tên';
      reply += `🔑 *${escMd(r.room_code)}* \\- ${escMd(tenant)} \\- ${escMd(amount)}đ\n`;
    }

    return { replyText: reply, parseMode: 'MarkdownV2' };
  } catch (err) {
    console.error(err);
    return { replyText: '❌ Lỗi khi lấy danh sách', parseMode: '' };
  }
}

async function handleChuaNhapDien() {
  try {
    const now = new Date();
    const vnNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const month = vnNow.getUTCMonth() + 1;
    const year = vnNow.getUTCFullYear();

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
      return { replyText: reply, parseMode: 'MarkdownV2' };
    }

    const codes = rows.map(r => r.room_code).join(', ');
    reply += `⚠️ Chưa nhập điện: *${rows.length}/${totalRooms}* phòng còn thiếu:\n\n`;
    reply += escMd(codes);
    reply += `\n\n💡 _Gửi theo dạng: \`A101: 2500\` để nhập_`;

    return { replyText: reply, parseMode: 'MarkdownV2' };
  } catch (err) {
    console.error(err);
    return { replyText: '❌ Lỗi khi lấy danh sách điện', parseMode: '' };
  }
}

async function handleChuaNhapDienByBillingDay(billingDay) {
  try {
    const now = new Date();
    const vnNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const month = vnNow.getUTCMonth() + 1;
    const year = vnNow.getUTCFullYear();

    const totalRow = await dbRef.prepare(`
      SELECT COUNT(*) as cnt
      FROM rooms
      WHERE status = 'occupied' AND COALESCE(billing_day, 30) = ?
    `).get(billingDay);
    const totalRooms = totalRow ? totalRow.cnt : 0;

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
      return { replyText: reply, parseMode: 'MarkdownV2' };
    }

    const codes = rows.map(r => r.room_code).join(', ');
    reply += `⚠️ Chưa nhập điện: *${rows.length}/${totalRooms}* phòng còn thiếu:\n\n`;
    reply += escMd(codes);
    reply += `\n\n💡 _Gửi theo dạng: \`A101: 2500\` để nhập_`;

    return { replyText: reply, parseMode: 'MarkdownV2' };
  } catch (err) {
    console.error(err);
    return { replyText: `❌ Lỗi khi lấy danh sách điện đợt ${billingDay}`, parseMode: '' };
  }
}

async function handleBaoCao() {
  try {
    const now = new Date();
    const vnNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const month = vnNow.getUTCMonth() + 1;
    const year = vnNow.getUTCFullYear();

    const roomStats = await dbRef.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'occupied' THEN 1 ELSE 0 END) as occupied,
        SUM(CASE WHEN status = 'vacant' THEN 1 ELSE 0 END) as vacant
      FROM rooms
    `).get();

    const payStats = await dbRef.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN is_paid = 1 THEN 1 ELSE 0 END) as paid,
        SUM(CASE WHEN is_paid = 1 THEN total_amount ELSE 0 END) as collected
      FROM rent_payments WHERE year = ? AND month = ?
    `).get(year, month);

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

    return { replyText: reply, parseMode: 'MarkdownV2' };
  } catch (err) {
    console.error(err);
    return { replyText: '❌ Lỗi khi tạo báo cáo', parseMode: '' };
  }
}

async function handleSoDien() {
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
      return { replyText: `📭 Không có phòng nào đang thuê để hiển thị số điện.`, parseMode: '' };
    }

    let reply = `⚡ *Số điện các phòng tháng ${month}/${year}*\n\n`;
    for (const r of rows) {
      if (r.new_reading !== null) {
        reply += `🔑 *${escMd(r.room_code)}*: ${escMd(String(r.new_reading))} kWh \\(dùng ${escMd(String(r.consumption))} kWh\\)\n`;
      } else {
        reply += `🔑 *${escMd(r.room_code)}*: _Chưa nhập_\n`;
      }
    }

    return { replyText: reply, parseMode: 'MarkdownV2' };
  } catch (err) {
    console.error(err);
    return { replyText: '❌ Lỗi khi lấy danh sách số điện các phòng', parseMode: '' };
  }
}

async function executeCommand(text) {
  if (!dbRef) {
    return { replyText: '❌ Hệ thống chưa kết nối cơ sở dữ liệu. Vui lòng thử lại sau vài giây.', parseMode: '' };
  }

  try {
    if (text === '/start' || text === '/help') {
      return await handleHelp();
    } else if (text.startsWith('/phong ')) {
      return await handlePhongCmd(text.slice(7).trim().toUpperCase());
    } else if (text === '/chuathu') {
      return await handleChuaThu();
    } else if (text === '/dien') {
      return await handleChuaNhapDien();
    } else if (text === '/dien15' || text === '/dien 15') {
      return await handleChuaNhapDienByBillingDay(15);
    } else if (text === '/dien30' || text === '/dien 30') {
      return await handleChuaNhapDienByBillingDay(30);
    } else if (text === '/baocao') {
      return await handleBaoCao();
    } else if (text === '/sodien') {
      return await handleSoDien();
    } else if (text.startsWith('/tienphong ')) {
      return await handleTienPhong(text.slice(11).trim().toUpperCase());
    } else {
      const parsed = parseElectricReadings(text);
      if (parsed.length > 0) {
        return await handleElectricInput(parsed);
      } else {
        return { replyText: '❓ Tôi không hiểu lệnh này.\n\nGõ /help để xem hướng dẫn.', parseMode: '' };
      }
    }
  } catch (err) {
    console.error('Assistant error:', err);
    return { replyText: '❌ Lỗi hệ thống: ' + err.message, parseMode: '' };
  }
}

module.exports = { executeCommand, setDb };
