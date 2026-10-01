const dns = require('dns');
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}
const express = require('express');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const db = require('./database');
const assistant = require('./assistant');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Route ping nhẹ để giữ server luôn thức trên Render
app.get('/api/ping', (req, res) => {
  res.status(200).send('pong');
});

// ==========================================
// 1. API DASHBOARD
// ==========================================
app.get('/api/dashboard', async (req, res) => {
  try {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    const totalRoomsRes = await db.prepare('SELECT COUNT(*) as count FROM rooms').get();
    const totalRooms = totalRoomsRes ? totalRoomsRes.count : 0;

    const occupiedRoomsRes = await db.prepare("SELECT COUNT(*) as count FROM rooms WHERE status = 'occupied'").get();
    const occupiedRooms = occupiedRoomsRes ? occupiedRoomsRes.count : 0;

    const vacantRoomsRes = await db.prepare("SELECT COUNT(*) as count FROM rooms WHERE status = 'vacant'").get();
    const vacantRooms = vacantRoomsRes ? vacantRoomsRes.count : 0;

    const maintenanceRoomsRes = await db.prepare("SELECT COUNT(*) as count FROM rooms WHERE status = 'maintenance'").get();
    const maintenanceRooms = maintenanceRoomsRes ? maintenanceRoomsRes.count : 0;

    const totalRentCostRes = await db.prepare("SELECT SUM(rent_price) as sum FROM rooms WHERE status = 'occupied'").get();
    const totalRentCost = totalRentCostRes ? totalRentCostRes.sum : 0;

    const totalElectricityCostRes = await db.prepare(
      'SELECT SUM(total_cost) as sum FROM electricity_readings WHERE year = ? AND month = ?'
    ).get(currentYear, currentMonth);
    const totalElectricityCost = totalElectricityCostRes ? totalElectricityCostRes.sum : 0;

    const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
    const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;
    const prevMonthElecRes = await db.prepare(
      'SELECT SUM(total_cost) as sum FROM electricity_readings WHERE year = ? AND month = ?'
    ).get(prevYear, prevMonth);
    const prevMonthElec = prevMonthElecRes ? prevMonthElecRes.sum : 0;

    // Lấy giá nước/rác/tạm trú từ settings
    const settingsList = await db.prepare('SELECT key, value FROM settings WHERE key IN (?, ?, ?, ?)').all('water_price', 'trash_price', 'electricity_price', 'residence_price');
    const settingsMap = {};
    settingsList.forEach(s => { settingsMap[s.key] = parseFloat(s.value) || 0; });
    const waterPrice = settingsMap['water_price'] || 20000;
    const trashPrice = settingsMap['trash_price'] || 10000;
    const residencePrice = settingsMap['residence_price'] || 50000;

    // Tính toán số liệu thu tiền đồng bộ 100% với tab danh sách thu tiền
    const rows = await db.prepare(`
      SELECT
        r.id as room_id,
        r.room_code,
        COALESCE(p.rent_amount, r.rent_price) as rent_price,
        r.status as room_status,
        r.member_count,
        (SELECT MIN(start_date) FROM tenants WHERE room_id = r.id) as lease_start_date,
        COALESCE(p.electricity_amount, e.total_cost) as electricity_amount,
        p.is_paid,
        p.rent_amount,
        p.electricity_amount as p_elec_amount,
        p.water_amount,
        p.trash_amount,
        p.residence_amount,
        p.total_amount
      FROM rooms r
      LEFT JOIN electricity_readings e ON e.room_id = r.id AND e.year = ? AND e.month = ?
      LEFT JOIN rent_payments p ON p.room_id = r.id AND p.year = ? AND p.month = ?
      WHERE r.status = 'occupied' OR p.id IS NOT NULL OR e.id IS NOT NULL
      GROUP BY r.id, p.id, e.id
    `).all(currentYear, currentMonth, currentYear, currentMonth);

    const filteredRows = rows.filter(row => {
      if (row.lease_start_date) {
        const leaseDate = new Date(row.lease_start_date);
        if (!isNaN(leaseDate.getTime())) {
          const leaseYear = leaseDate.getFullYear();
          const leaseMonth = leaseDate.getMonth() + 1;
          // Nếu thuê bắt đầu từ tháng này hoặc tương lai, và chưa thanh toán, thì không tính tiền tháng này
          if ((leaseYear > currentYear || (leaseYear === currentYear && leaseMonth >= currentMonth)) && row.is_paid !== 1) {
            return false;
          }
        }
      }
      return true;
    });

    let paidCount = 0;
    let unpaidCount = 0;
    let collected = 0;
    let pending = 0;

    filteredRows.forEach(row => {
      const isPaid = row.is_paid === 1;
      const memberCount = row.member_count || 0;

      // Xác định tháng đầu tiên thu tiền (sau tháng bắt đầu hợp đồng 1 tháng)
      let isFirstMonth = false;
      if (row.lease_start_date) {
        const leaseDate = new Date(row.lease_start_date);
        if (!isNaN(leaseDate.getTime())) {
          const leaseYear = leaseDate.getFullYear();
          const leaseMonth = leaseDate.getMonth() + 1;
          const diffMonths = (currentYear - leaseYear) * 12 + (currentMonth - leaseMonth);
          if (diffMonths === 1) {
            isFirstMonth = true;
          }
        }
      }

      const rentAmt = row.rent_price || 0;
      const elecAmt = row.electricity_amount || 0;
      const waterAmt = (isPaid && row.water_amount !== null && row.water_amount !== undefined)
        ? row.water_amount
        : waterPrice * memberCount;
      const trashAmt = (isPaid && row.trash_amount !== null && row.trash_amount !== undefined)
        ? row.trash_amount
        : trashPrice * memberCount;
      const residenceAmt = (isPaid && row.residence_amount !== null && row.residence_amount !== undefined)
        ? row.residence_amount
        : (isFirstMonth ? residencePrice * memberCount : 0);

      const totalAmt = isPaid
        ? (row.total_amount || (rentAmt + elecAmt + waterAmt + trashAmt + residenceAmt))
        : (rentAmt + elecAmt + waterAmt + trashAmt + residenceAmt);

      if (isPaid) {
        paidCount++;
        collected += totalAmt;
      } else {
        unpaidCount++;
        pending += totalAmt;
      }
    });

    res.json({
      totalRooms, occupiedRooms, vacantRooms, maintenanceRooms,
      totalRentCost,
      totalElectricityCost: totalElectricityCost > 0 ? totalElectricityCost : prevMonthElec,
      electricityMonth: totalElectricityCost > 0 ? currentMonth : prevMonth,
      electricityYear: totalElectricityCost > 0 ? currentYear : prevYear,
      paymentStats: {
        total: rows.length,
        paidCount,
        unpaidCount,
        collected,
        pending
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. API PHÒNG (ROOMS)
// ==========================================
app.get('/api/rooms', async (req, res) => {
  try {
    const { zone, status } = req.query;
    let query = 'SELECT * FROM rooms';
    const params = [];
    const conditions = [];
    if (zone) { conditions.push('zone = ?'); params.push(zone); }
    if (status) { conditions.push('status = ?'); params.push(status); }
    if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY room_code ASC';
    res.json(await db.prepare(query).all(...params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rooms/:id', async (req, res) => {
  try {
    const room = await db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Không tìm thấy phòng này' });
    const tenants = await db.prepare('SELECT * FROM tenants WHERE room_id = ? ORDER BY id DESC').all(req.params.id);
    const electricityHistory = await db.prepare(
      'SELECT * FROM electricity_readings WHERE room_id = ? ORDER BY year DESC, month DESC LIMIT 12'
    ).all(req.params.id);
    const paymentHistory = await db.prepare(
      'SELECT * FROM rent_payments WHERE room_id = ? ORDER BY year DESC, month DESC LIMIT 12'
    ).all(req.params.id);
    res.json({ room, tenants, electricityHistory, paymentHistory });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rooms/:id', async (req, res) => {
  try {
    const { rent_price, deposit, status, member_count, billing_day } = req.body;

    // Nếu chuyển trạng thái thành trống (vacant), tự động xóa sạch người thuê trong phòng
    if (status === 'vacant') {
      await db.prepare('DELETE FROM tenants WHERE room_id = ?').run(req.params.id);
    }

    // Đếm số lượng người thuê thực tế đăng ký trong DB
    const countResult = await db.prepare('SELECT COUNT(*) as count FROM tenants WHERE room_id = ?').get(req.params.id);
    const actualCount = countResult ? countResult.count : 0;

    let finalMemberCount = parseInt(member_count);
    if (isNaN(finalMemberCount) || finalMemberCount < 0) finalMemberCount = 0;

    let finalStatus = status || 'vacant';
    if (status === 'vacant') {
      finalMemberCount = 0;
      finalStatus = 'vacant';
    } else if (status === 'maintenance') {
      finalStatus = 'maintenance';
      if (actualCount === 0) finalMemberCount = 0;
    } else if (actualCount === 0) {
      // Không có người thuê đăng ký => bắt buộc trạng thái Trống và số người = 0
      finalStatus = 'vacant';
      finalMemberCount = 0;
    } else {
      // Có người thuê trong DB
      finalStatus = 'occupied';
      if (finalMemberCount < 1) {
        finalMemberCount = actualCount;
      }
    }

    const finalBillingDay = billing_day === 15 ? 15 : 30; // Chỉ chấp nhận 15 hoặc 30

    const info = await db.prepare(
      'UPDATE rooms SET rent_price = ?, deposit = ?, status = ?, member_count = ?, billing_day = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(rent_price, deposit, finalStatus, finalMemberCount, finalBillingDay, req.params.id);

    if (info.changes === 0) return res.status(404).json({ error: 'Không tìm thấy phòng' });
    res.json({ message: 'Cập nhật phòng thành công', status: finalStatus, member_count: finalMemberCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. API NGƯỜI THUÊ (TENANTS)
// ==========================================
app.post('/api/tenants', async (req, res) => {
  try {
    const { room_id, full_name, phone, cccd, start_date, end_date, notes, member_count } = req.body;
    if (!room_id || !full_name || !start_date)
      return res.status(400).json({ error: 'Vui lòng điền đầy đủ Họ tên và Ngày bắt đầu' });

    const info = await db.prepare(
      'INSERT INTO tenants (room_id, full_name, phone, cccd, start_date, end_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
    ).run(room_id, full_name, phone || null, cccd || null, start_date, end_date || null, notes || null);

    const room = await db.prepare('SELECT member_count FROM rooms WHERE id = ?').get(room_id);
    const currentMembers = room ? (room.member_count || 0) : 0;
    const countAfterAdd = await db.prepare('SELECT COUNT(*) as count FROM tenants WHERE room_id = ?').get(room_id);
    const actualCountAfterAdd = countAfterAdd ? countAfterAdd.count : 1;

    let newMembers;
    if (member_count !== undefined && member_count !== null && parseInt(member_count) > 0) {
      newMembers = parseInt(member_count);
    } else {
      newMembers = currentMembers > 0 ? Math.max(currentMembers + 1, actualCountAfterAdd) : Math.max(1, actualCountAfterAdd);
    }

    await db.prepare(
      "UPDATE rooms SET member_count = ?, status = 'occupied', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(newMembers, room_id);

    res.status(201).json({ id: info.lastInsertRowid, message: 'Thêm người thuê thành công', member_count: newMembers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tenants/:id', async (req, res) => {
  try {
    const { full_name, phone, cccd, start_date, end_date, notes } = req.body;
    if (!full_name || !start_date)
      return res.status(400).json({ error: 'Họ tên và Ngày bắt đầu không được để trống' });
    const info = await db.prepare(
      'UPDATE tenants SET full_name = ?, phone = ?, cccd = ?, start_date = ?, end_date = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(full_name, phone, cccd, start_date, end_date, notes, req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Không tìm thấy người thuê' });
    res.json({ message: 'Sửa thông tin người thuê thành công' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tenants/:id', async (req, res) => {
  try {
    const tenant = await db.prepare('SELECT room_id FROM tenants WHERE id = ?').get(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Không tìm thấy người thuê' });

    await db.prepare('DELETE FROM tenants WHERE id = ?').run(req.params.id);

    // Kiểm tra số lượng người thuê còn lại trong DB
    const countResult = await db.prepare('SELECT COUNT(*) as count FROM tenants WHERE room_id = ?').get(tenant.room_id);
    const actualCount = countResult ? countResult.count : 0;

    if (actualCount === 0) {
      // Nếu không còn bất kỳ người thuê đăng ký nào, đưa trạng thái phòng về trống và số người về 0
      await db.prepare(
        "UPDATE rooms SET member_count = 0, status = 'vacant', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(tenant.room_id);
    } else {
      const roomData = await db.prepare('SELECT member_count FROM rooms WHERE id = ?').get(tenant.room_id);
      const currentMembers = roomData ? (roomData.member_count || 0) : actualCount;
      const newMembers = Math.max(actualCount, Math.max(1, currentMembers - 1));
      await db.prepare(
        "UPDATE rooms SET member_count = ?, status = 'occupied', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(newMembers, tenant.room_id);
    }

    res.json({ message: 'Xóa người thuê thành công' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. API ĐIỆN NĂNG (ELECTRICITY)
// ==========================================
app.get('/api/electricity/last-reading/:roomId', async (req, res) => {
  try {
    const last = await db.prepare(
      'SELECT new_reading FROM electricity_readings WHERE room_id = ? ORDER BY year DESC, month DESC LIMIT 1'
    ).get(req.params.roomId);
    res.json({ lastReading: last ? last.new_reading : 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/electricity', async (req, res) => {
  try {
    const { room_id, year, month, old_reading, new_reading } = req.body;
    if (!room_id || !year || !month || old_reading === undefined || new_reading === undefined)
      return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });
    if (parseFloat(new_reading) < parseFloat(old_reading))
      return res.status(400).json({ error: 'Chỉ số mới không được nhỏ hơn chỉ số cũ' });

    const priceSetting = await db.prepare("SELECT value FROM settings WHERE key = 'electricity_price'").get();
    const unitPrice = priceSetting ? parseFloat(priceSetting.value) : 3500;
    const consumption = parseFloat(new_reading) - parseFloat(old_reading);
    const totalCost = consumption * unitPrice;

    await db.prepare(`
      INSERT INTO electricity_readings (room_id, year, month, old_reading, new_reading, consumption, unit_price, total_cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id, year, month) DO UPDATE SET
        old_reading = EXCLUDED.old_reading, new_reading = EXCLUDED.new_reading,
        consumption = EXCLUDED.consumption, unit_price = EXCLUDED.unit_price, total_cost = EXCLUDED.total_cost
    `).run(room_id, parseInt(year), parseInt(month), parseFloat(old_reading), parseFloat(new_reading), consumption, unitPrice, totalCost);

    // Đồng bộ với bảng rent_payments nếu bản ghi thanh toán của tháng đó đã tồn tại
    await db.prepare(`
      UPDATE rent_payments
      SET electricity_amount = ?, total_amount = rent_amount + ? + water_amount + trash_amount + residence_amount + deposit_amount, updated_at = CURRENT_TIMESTAMP
      WHERE room_id = ? AND year = ? AND month = ?
    `).run(totalCost, totalCost, room_id, parseInt(year), parseInt(month));

    res.json({ message: 'Lưu chỉ số điện thành công', consumption, totalCost });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// API ĐIỆN HÀNG LOẠT (BULK ELECTRICITY)
// ==========================================

// Lấy dữ liệu bulk: danh sách phòng + chỉ số cũ gần nhất + chỉ số đã nhập tháng này (nếu có)
app.get('/api/electricity/bulk-data', async (req, res) => {
  try {
    const { year, month } = req.query;
    if (!year || !month) return res.status(400).json({ error: 'Cần cung cấp year và month' });

    const y = parseInt(year);
    const m = parseInt(month);

    // Lấy tất cả phòng (bao gồm billing_day để biết đợt thu tiền)
    const rooms = await db.prepare(
      "SELECT r.*, r.billing_day, (SELECT COUNT(*) FROM tenants t WHERE t.room_id = r.id) as tenant_count FROM rooms r ORDER BY r.zone ASC, r.room_code ASC"
    ).all();

    // Lấy chỉ số điện tháng hiện tại (nếu đã nhập)
    const currentReadings = await db.prepare(
      'SELECT * FROM electricity_readings WHERE year = ? AND month = ?'
    ).all(y, m);
    const currentMap = {};
    currentReadings.forEach(r => { currentMap[r.room_id] = r; });

    // Lấy chỉ số cũ (new_reading của tháng trước) hoặc chỉ số mới nhất (SQLite compatible)
    const lastReadings = await db.prepare(`
      SELECT e.room_id, e.new_reading, e.year, e.month
      FROM electricity_readings e
      INNER JOIN (
        SELECT room_id, MAX(year * 100 + month) as max_ym
        FROM electricity_readings
        WHERE (year < ? OR (year = ? AND month < ?))
        GROUP BY room_id
      ) latest ON e.room_id = latest.room_id AND (e.year * 100 + e.month) = latest.max_ym
    `).all(y, y, m);
    const lastMap = {};
    lastReadings.forEach(r => { lastMap[r.room_id] = r.new_reading; });

    // Combine
    const result = rooms.map(room => ({
      id: room.id,
      room_code: room.room_code,
      zone: room.zone,
      status: room.status,
      tenant_count: room.tenant_count,
      billing_day: room.billing_day || 30,
      last_reading: lastMap[room.id] !== undefined ? lastMap[room.id] : 0,
      current: currentMap[room.id] || null
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lưu hàng loạt chỉ số điện
app.post('/api/electricity/bulk', async (req, res) => {
  try {
    const { year, month, readings } = req.body;
    // readings: [{ room_id, old_reading, new_reading }]
    if (!year || !month || !Array.isArray(readings) || readings.length === 0)
      return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });

    const priceSetting = await db.prepare("SELECT value FROM settings WHERE key = 'electricity_price'").get();
    const unitPrice = priceSetting ? parseFloat(priceSetting.value) : 3500;

    const results = [];
    let errorCount = 0;

    for (const r of readings) {
      const { room_id, old_reading, new_reading } = r;
      if (new_reading === '' || new_reading === null || new_reading === undefined) continue;
      const newVal = parseFloat(new_reading);
      const oldVal = parseFloat(old_reading) || 0;
      if (newVal < oldVal) { errorCount++; continue; }

      const consumption = newVal - oldVal;
      const totalCost = consumption * unitPrice;

      await db.prepare(`
        INSERT INTO electricity_readings (room_id, year, month, old_reading, new_reading, consumption, unit_price, total_cost)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(room_id, year, month) DO UPDATE SET
          old_reading = EXCLUDED.old_reading, new_reading = EXCLUDED.new_reading,
          consumption = EXCLUDED.consumption, unit_price = EXCLUDED.unit_price, total_cost = EXCLUDED.total_cost
      `).run(room_id, parseInt(year), parseInt(month), oldVal, newVal, consumption, unitPrice, totalCost);

      // Sync với rent_payments nếu tồn tại
      await db.prepare(`
        UPDATE rent_payments
        SET electricity_amount = ?, total_amount = rent_amount + ? + water_amount + trash_amount + residence_amount + deposit_amount, updated_at = CURRENT_TIMESTAMP
        WHERE room_id = ? AND year = ? AND month = ?
      `).run(totalCost, totalCost, room_id, parseInt(year), parseInt(month));

      results.push({ room_id, consumption, totalCost });
    }

    res.json({
      message: `Đã lưu ${results.length} phòng thành công${errorCount > 0 ? `, bỏ qua ${errorCount} phòng lỗi` : ''}`,
      saved: results.length,
      errors: errorCount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 5. API THU TIỀN THÁNG (RENT PAYMENTS) 💰
// ==========================================

// Lấy danh sách thu tiền của tháng/năm - bao gồm tiền thuê + tiền điện từng phòng
app.get('/api/payments', async (req, res) => {
  try {
    const { year, month } = req.query;
    if (!year || !month) return res.status(400).json({ error: 'Cần cung cấp year và month' });

    // Lấy giá nước/rác/tạm trú từ settings
    const settingsList = await db.prepare('SELECT key, value FROM settings WHERE key IN (?, ?, ?, ?)').all('water_price', 'trash_price', 'electricity_price', 'residence_price');
    const settingsMap = {};
    settingsList.forEach(s => { settingsMap[s.key] = parseFloat(s.value) || 0; });
    const waterPrice = settingsMap['water_price'] || 20000;
    const trashPrice = settingsMap['trash_price'] || 10000;
    const residencePrice = settingsMap['residence_price'] || 50000;

    const rows = await db.prepare(`
      SELECT
        r.id as room_id,
        r.room_code,
        r.zone,
        r.billing_day,
        COALESCE(p.rent_amount, r.rent_price) as rent_price,
        r.status as room_status,
        r.member_count,
        r.deposit,
        (SELECT MIN(start_date) FROM tenants WHERE room_id = r.id) as lease_start_date,
        (SELECT MAX(end_date) FROM tenants WHERE room_id = r.id AND end_date IS NOT NULL) as end_date,
        COALESCE(p.tenant_name, STRING_AGG(t.full_name, ', ')) as tenant_names,
        STRING_AGG(t.phone, ', ') as tenant_phones,
        COALESCE(p.electricity_amount, e.total_cost) as electricity_amount,
        e.consumption,
        p.id as payment_id,
        p.is_paid,
        p.rent_amount,
        p.electricity_amount as p_elec_amount,
        p.water_amount,
        p.trash_amount,
        p.residence_amount,
        p.deposit_amount,
        p.total_amount,
        p.paid_at,
        p.note
      FROM rooms r
      LEFT JOIN tenants t ON t.room_id = r.id
      LEFT JOIN electricity_readings e ON e.room_id = r.id AND e.year = ? AND e.month = ?
      LEFT JOIN rent_payments p ON p.room_id = r.id AND p.year = ? AND p.month = ?
      WHERE r.status = 'occupied' OR p.id IS NOT NULL OR e.id IS NOT NULL
      GROUP BY r.id, p.id, e.id
      ORDER BY
        CASE WHEN p.is_paid IS NULL OR p.is_paid = 0 THEN 0 ELSE 1 END ASC,
        r.room_code ASC
    `).all(parseInt(year), parseInt(month), parseInt(year), parseInt(month));

    const filteredRows = rows.filter(row => {
      if (row.lease_start_date) {
        const leaseDate = new Date(row.lease_start_date);
        if (!isNaN(leaseDate.getTime())) {
          const leaseYear = leaseDate.getFullYear();
          const leaseMonth = leaseDate.getMonth() + 1;
          const billingYear = parseInt(year);
          const billingMonth = parseInt(month);
          // Chỉ loại trừ phòng chưa bắt đầu thuê (tháng tương lai)
          if (leaseYear > billingYear || (leaseYear === billingYear && leaseMonth > billingMonth)) {
            return false;
          }
        }
      }
      return true;
    });

    const enrichedRows = filteredRows.map(row => {
      const memberCount = row.member_count || 0;
      const isPaid = row.is_paid === 1;

      let isFirstMonth = false;
      let isCheckout = false;
      let proratedRent = row.rent_price || 0;

      if (row.lease_start_date) {
        const leaseDate = new Date(row.lease_start_date);
        if (!isNaN(leaseDate.getTime())) {
          const leaseYear = leaseDate.getFullYear();
          const leaseMonth = leaseDate.getMonth() + 1;
          const diffMonths = (parseInt(year) - leaseYear) * 12 + (parseInt(month) - leaseMonth);
          if (diffMonths === 0) {
            isFirstMonth = true;
          }
        }
      }

      // Kiểm tra trả phòng: tenant có end_date trong tháng billing
      const endDate = row.end_date;
      if (endDate) {
        const ed = new Date(endDate);
        if (!isNaN(ed.getTime())) {
          const edYear = ed.getFullYear();
          const edMonth = ed.getMonth() + 1;
          if (edYear === parseInt(year) && edMonth === parseInt(month)) {
            isCheckout = true;
          }
        }
      }

      // Tính tiền nhà theo ngày nếu là tháng đầu hoặc trả phòng
      if (!isPaid) {
        if (isFirstMonth && row.lease_start_date) {
          const leaseDate = new Date(row.lease_start_date);
          const billingDay = row.billing_day || 30;
          const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
          const endOfPeriod = Math.min(billingDay, lastDay);
          const startDay = leaseDate.getDate();
          const daysStayed = endOfPeriod - startDay + 1;
          if (daysStayed <= 0) {
            proratedRent = 0;
          } else if (daysStayed <= 15) {
            proratedRent = (row.rent_price || 0) / 2;
          } else {
            proratedRent = row.rent_price || 0;
          }
        } else if (isCheckout && endDate) {
          const ed = new Date(endDate);
          const dayOfMonth = ed.getDate();
          if (dayOfMonth <= 15) {
            proratedRent = (row.rent_price || 0) / 2;
          } else {
            proratedRent = row.rent_price || 0;
          }
        }
      }

      const rentAmt = (isPaid && row.rent_amount !== null && row.rent_amount !== undefined)
        ? row.rent_amount : proratedRent;
      const waterAmt = (isPaid && row.water_amount !== null && row.water_amount !== undefined)
        ? row.water_amount : waterPrice * memberCount;
      const trashAmt = (isPaid && row.trash_amount !== null && row.trash_amount !== undefined)
        ? row.trash_amount : trashPrice * memberCount;
      const residenceAmt = (isPaid && row.residence_amount !== null && row.residence_amount !== undefined)
        ? row.residence_amount : (isFirstMonth ? residencePrice * memberCount : 0);
      const depositAmt = (isPaid && row.deposit_amount !== null && row.deposit_amount !== undefined)
        ? row.deposit_amount : (isFirstMonth ? (row.deposit || 0) : 0);

      return {
        ...row,
        rent_price: rentAmt,
        water_amount: waterAmt,
        trash_amount: trashAmt,
        residence_amount: residenceAmt,
        deposit_amount: depositAmt,
        waterPrice,
        trashPrice,
        residencePrice,
        isFirstMonth,
        isCheckout
      };
    });

    res.json(enrichedRows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Đánh dấu đã thu / chưa thu tiền
app.post('/api/payments/mark', async (req, res) => {
  try {
    const { room_id, year, month, is_paid, note } = req.body;
    if (!room_id || !year || !month)
      return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });

    const room = await db.prepare('SELECT rent_price, deposit, member_count, billing_day FROM rooms WHERE id = ?').get(room_id);
    if (!room) return res.status(404).json({ error: 'Không tìm thấy phòng' });

    const elec = await db.prepare(
      'SELECT total_cost FROM electricity_readings WHERE room_id = ? AND year = ? AND month = ?'
    ).get(room_id, parseInt(year), parseInt(month));

    const tenants = await db.prepare('SELECT full_name FROM tenants WHERE room_id = ?').all(room_id);
    const tenantName = tenants.map(t => t.full_name).join(', ') || null;

    // Lấy giá nước/rác/tạm trú từ settings
    const settingsList = await db.prepare('SELECT key, value FROM settings WHERE key IN (?, ?, ?)')
      .all('water_price', 'trash_price', 'residence_price');
    const settingsMap = {};
    settingsList.forEach(s => { settingsMap[s.key] = parseFloat(s.value) || 0; });
    const waterPrice = settingsMap['water_price'] || 20000;
    const trashPrice = settingsMap['trash_price'] || 10000;
    const residencePrice = settingsMap['residence_price'] || 50000;
    const memberCount = room.member_count || 0;

    // Xác định tháng đầu tiên và trả phòng
    const earliestTenant = await db.prepare('SELECT MIN(start_date) as start_date FROM tenants WHERE room_id = ?').get(room_id);
    const latestEndDate = await db.prepare('SELECT MAX(end_date) as end_date FROM tenants WHERE room_id = ? AND end_date IS NOT NULL').get(room_id);
    let isFirstMonth = false;
    let isCheckout = false;
    let proratedRent = room.rent_price || 0;

    if (earliestTenant && earliestTenant.start_date) {
      const leaseDate = new Date(earliestTenant.start_date);
      if (!isNaN(leaseDate.getTime())) {
        const leaseYear = leaseDate.getFullYear();
        const leaseMonth = leaseDate.getMonth() + 1;
        const diffMonths = (parseInt(year) - leaseYear) * 12 + (parseInt(month) - leaseMonth);
        if (diffMonths === 0) {
          isFirstMonth = true;
          const billingDay = room.billing_day || 30;
          const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
          const endOfPeriod = Math.min(billingDay, lastDay);
          const startDay = leaseDate.getDate();
          const daysStayed = endOfPeriod - startDay + 1;
          if (daysStayed <= 0) {
            proratedRent = 0;
          } else if (daysStayed <= 15) {
            proratedRent = (room.rent_price || 0) / 2;
          } else {
            proratedRent = room.rent_price || 0;
          }
        }
      }
    }

    if (latestEndDate && latestEndDate.end_date) {
      const ed = new Date(latestEndDate.end_date);
      if (!isNaN(ed.getTime())) {
        const edYear = ed.getFullYear();
        const edMonth = ed.getMonth() + 1;
        if (edYear === parseInt(year) && edMonth === parseInt(month)) {
          isCheckout = true;
          const dayOfMonth = ed.getDate();
          if (dayOfMonth <= 15) {
            proratedRent = (room.rent_price || 0) / 2;
          } else {
            proratedRent = room.rent_price || 0;
          }
        }
      }
    }

    const rentAmount = proratedRent;
    const elecAmount = elec ? elec.total_cost : 0;
    const waterAmount = waterPrice * memberCount;
    const trashAmount = trashPrice * memberCount;
    const residenceAmount = isFirstMonth ? (residencePrice * memberCount) : 0;
    const depositAmount = isFirstMonth ? (room.deposit || 0) : 0;
    const totalAmount = rentAmount + elecAmount + waterAmount + trashAmount + residenceAmount + depositAmount;
    const paidAt = is_paid ? new Date().toISOString() : null;

    await db.prepare(`
      INSERT INTO rent_payments (room_id, year, month, rent_amount, electricity_amount, water_amount, trash_amount, residence_amount, deposit_amount, total_amount, is_paid, paid_at, note, tenant_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id, year, month) DO UPDATE SET
        rent_amount = EXCLUDED.rent_amount,
        electricity_amount = EXCLUDED.electricity_amount,
        water_amount = EXCLUDED.water_amount,
        trash_amount = EXCLUDED.trash_amount,
        residence_amount = EXCLUDED.residence_amount,
        deposit_amount = EXCLUDED.deposit_amount,
        total_amount = EXCLUDED.total_amount,
        is_paid = EXCLUDED.is_paid,
        paid_at = EXCLUDED.paid_at,
        note = EXCLUDED.note,
        tenant_name = COALESCE(EXCLUDED.tenant_name, rent_payments.tenant_name),
        updated_at = CURRENT_TIMESTAMP
    `).run(room_id, parseInt(year), parseInt(month), rentAmount, elecAmount, waterAmount, trashAmount, residenceAmount, depositAmount, totalAmount, is_paid ? 1 : 0, paidAt, note || null, tenantName);

    res.json({ message: is_paid ? '✅ Đã đánh dấu ĐÃ THU tiền' : '↩️ Đã bỏ đánh dấu thu tiền', totalAmount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 6. API SETTINGS (CÀI ĐẶT)
// ==========================================
app.get('/api/settings', async (req, res) => {
  try {
    const list = await db.prepare('SELECT * FROM settings').all();
    const obj = {};
    list.forEach(s => { obj[s.key] = s.value; });
    res.json(obj);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const upsertSetting = async (key, val) => {
  if (val !== undefined && val !== null) {
    await db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP"
    ).run(key, val.toString());
  }
};

app.put('/api/settings', async (req, res) => {
  try {
    const {
      electricity_price, water_price, trash_price, residence_price, payment_due_day,
      bank_name, bank_account, bank_owner,
      email_sender, email_pass, email_receiver, email_enabled
    } = req.body;

    await upsertSetting('electricity_price', electricity_price);
    await upsertSetting('water_price', water_price);
    await upsertSetting('trash_price', trash_price);
    await upsertSetting('residence_price', residence_price);
    await upsertSetting('payment_due_day', payment_due_day);
    await upsertSetting('bank_name', bank_name);
    await upsertSetting('bank_account', bank_account);
    await upsertSetting('bank_owner', bank_owner);
    await upsertSetting('email_sender', email_sender);
    await upsertSetting('email_pass', email_pass);
    await upsertSetting('email_receiver', email_receiver);
    await upsertSetting('email_enabled', email_enabled);

    res.json({ message: 'Cập nhật cài đặt thành công' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 6.1 GMAIL NOTIFICATIONS & CRON ENGINE
// ==========================================

function getVietnamDate() {
  const now = new Date();
  const vnDateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); // YYYY-MM-DD
  const [year, month, day] = vnDateStr.split('-').map(Number);
  return { now, dateStr: vnDateStr, year, month, day };
}

function formatVND(amount) {
  return new Intl.NumberFormat('vi-VN').format(Math.round(amount || 0)) + ' đ';
}

const DEFAULT_EMAIL_SENDER = process.env.EMAIL_SENDER || 'nhatroliso@gmail.com';
const DEFAULT_EMAIL_PASS = process.env.EMAIL_PASS || 'cxma vytw meqc bitp';
const DEFAULT_EMAIL_RECEIVER = process.env.EMAIL_RECEIVER || 'nhatroliso@gmail.com';

function createEmailTransporter(sender, pass) {
  const user = (sender || DEFAULT_EMAIL_SENDER).trim();
  const rawPass = (pass || DEFAULT_EMAIL_PASS).replace(/\s+/g, '');
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user,
      pass: rawPass
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
}

async function getDailyReportData(settingsMap, vnDate) {
  const { year, month, day } = vnDate;

  const waterPrice = parseFloat(settingsMap.water_price || 20000);
  const trashPrice = parseFloat(settingsMap.trash_price || 10000);
  const residencePrice = parseFloat(settingsMap.residence_price || 50000);
  const defaultDueDay = parseInt(settingsMap.payment_due_day || 15);

  const rows = await db.prepare(`
    SELECT
      r.id as room_id,
      r.room_code,
      r.zone,
      r.billing_day,
      COALESCE(p.rent_amount, r.rent_price) as rent_price,
      r.status as room_status,
      r.member_count,
      r.deposit,
      (SELECT MIN(start_date) FROM tenants WHERE room_id = r.id) as lease_start_date,
      (SELECT MAX(end_date) FROM tenants WHERE room_id = r.id AND end_date IS NOT NULL) as end_date,
      COALESCE(p.tenant_name, STRING_AGG(t.full_name, ', ')) as tenant_names,
      STRING_AGG(t.phone, ', ') as tenant_phones,
      COALESCE(p.electricity_amount, e.total_cost) as electricity_amount,
      e.consumption,
      p.id as payment_id,
      p.is_paid,
      p.rent_amount,
      p.electricity_amount as p_elec_amount,
      p.water_amount,
      p.trash_amount,
      p.residence_amount,
      p.deposit_amount,
      p.total_amount,
      p.paid_at,
      p.note
    FROM rooms r
    LEFT JOIN tenants t ON t.room_id = r.id
    LEFT JOIN electricity_readings e ON e.room_id = r.id AND e.year = ? AND e.month = ?
    LEFT JOIN rent_payments p ON p.room_id = r.id AND p.year = ? AND p.month = ?
    WHERE r.status = 'occupied' OR p.id IS NOT NULL OR e.id IS NOT NULL
    GROUP BY r.id, p.id, e.id
    ORDER BY r.room_code ASC
  `).all(year, month, year, month);

  const filteredRows = rows.filter(row => {
    if (row.lease_start_date) {
      const leaseDate = new Date(row.lease_start_date);
      if (!isNaN(leaseDate.getTime())) {
        const leaseYear = leaseDate.getFullYear();
        const leaseMonth = leaseDate.getMonth() + 1;
        if (leaseYear > year || (leaseYear === year && leaseMonth > month)) {
          return false;
        }
      }
    }
    return true;
  });

  const daysInCurrentMonth = new Date(year, month, 0).getDate();

  let totalPaidMoney = 0;
  let totalUnpaidMoney = 0;
  let totalExpectedMoney = 0;
  let paidCount = 0;
  let unpaidCount = 0;

  const overdueRooms = [];
  const dueTodayRooms = [];
  const upcomingRooms = [];
  const otherUnpaidRooms = [];
  const paidRooms = [];

  filteredRows.forEach(row => {
    const memberCount = row.member_count || 0;
    const isPaid = row.is_paid === 1;

    let isFirstMonth = false;
    let isCheckout = false;
    let proratedRent = row.rent_price || 0;

    if (row.lease_start_date) {
      const leaseDate = new Date(row.lease_start_date);
      if (!isNaN(leaseDate.getTime())) {
        const leaseYear = leaseDate.getFullYear();
        const leaseMonth = leaseDate.getMonth() + 1;
        const diffMonths = (year - leaseYear) * 12 + (month - leaseMonth);
        if (diffMonths === 0) {
          isFirstMonth = true;
        }
      }
    }

    const endDate = row.end_date;
    if (endDate) {
      const ed = new Date(endDate);
      if (!isNaN(ed.getTime())) {
        const edYear = ed.getFullYear();
        const edMonth = ed.getMonth() + 1;
        if (edYear === year && edMonth === month) {
          isCheckout = true;
        }
      }
    }

    if (!isPaid) {
      if (isFirstMonth && row.lease_start_date) {
        const leaseDate = new Date(row.lease_start_date);
        const billingDay = row.billing_day || 30;
        const endOfPeriod = Math.min(billingDay, daysInCurrentMonth);
        const startDay = leaseDate.getDate();
        const daysStayed = endOfPeriod - startDay + 1;
        if (daysStayed <= 0) {
          proratedRent = 0;
        } else if (daysStayed <= 15) {
          proratedRent = (row.rent_price || 0) / 2;
        } else {
          proratedRent = row.rent_price || 0;
        }
      } else if (isCheckout && endDate) {
        const ed = new Date(endDate);
        const dayOfMonth = ed.getDate();
        if (dayOfMonth <= 15) {
          proratedRent = (row.rent_price || 0) / 2;
        } else {
          proratedRent = row.rent_price || 0;
        }
      }
    }

    const rentAmount = (isPaid && row.rent_amount !== null && row.rent_amount !== undefined)
      ? row.rent_amount : proratedRent;
    const elecAmount = (isPaid && row.p_elec_amount !== null && row.p_elec_amount !== undefined)
      ? row.p_elec_amount : (row.electricity_amount || 0);
    const waterAmount = (isPaid && row.water_amount !== null && row.water_amount !== undefined)
      ? row.water_amount : waterPrice * memberCount;
    const trashAmount = (isPaid && row.trash_amount !== null && row.trash_amount !== undefined)
      ? row.trash_amount : trashPrice * memberCount;
    const residenceAmount = (isPaid && row.residence_amount !== null && row.residence_amount !== undefined)
      ? row.residence_amount : (isFirstMonth ? residencePrice * memberCount : 0);
    const depositAmount = (isPaid && row.deposit_amount !== null && row.deposit_amount !== undefined)
      ? row.deposit_amount : (isFirstMonth ? (row.deposit || 0) : 0);

    const totalAmount = isPaid && row.total_amount
      ? row.total_amount
      : (rentAmount + elecAmount + waterAmount + trashAmount + residenceAmount + depositAmount);

    totalExpectedMoney += totalAmount;

    const roomDueDay = row.billing_day ? parseInt(row.billing_day) : defaultDueDay;
    const finalDueDay = Math.min(roomDueDay, daysInCurrentMonth);
    const daysUntilDue = finalDueDay - day;

    const enriched = {
      ...row,
      rent_amount: rentAmount,
      elec_amount: elecAmount,
      water_amount: waterAmount,
      trash_amount: trashAmount,
      residence_amount: residenceAmount,
      deposit_amount: depositAmount,
      total_amount: totalAmount,
      final_due_day: finalDueDay,
      days_until_due: daysUntilDue,
      is_first_month: isFirstMonth,
      is_checkout: isCheckout
    };

    if (isPaid) {
      paidCount++;
      totalPaidMoney += totalAmount;
      paidRooms.push(enriched);
    } else {
      unpaidCount++;
      totalUnpaidMoney += totalAmount;
      if (daysUntilDue < 0) {
        overdueRooms.push(enriched);
      } else if (daysUntilDue === 0) {
        dueTodayRooms.push(enriched);
      } else if (daysUntilDue > 0 && daysUntilDue <= 3) {
        upcomingRooms.push(enriched);
      } else {
        otherUnpaidRooms.push(enriched);
      }
    }
  });

  return {
    dateStr: `${day}/${month}/${year}`,
    year,
    month,
    day,
    totalOccupied: filteredRows.length,
    paidCount,
    unpaidCount,
    totalPaidMoney,
    totalUnpaidMoney,
    totalExpectedMoney,
    overdueRooms,
    dueTodayRooms,
    upcomingRooms,
    otherUnpaidRooms,
    paidRooms
  };
}

function generateDailyEmailHTML(data) {
  const {
    dateStr,
    totalOccupied,
    paidCount,
    unpaidCount,
    totalPaidMoney,
    totalUnpaidMoney,
    totalExpectedMoney,
    overdueRooms,
    dueTodayRooms,
    upcomingRooms,
    otherUnpaidRooms
  } = data;

  const overdueSection = overdueRooms.length > 0 ? `
    <div style="margin-bottom: 24px; background: #fff5f5; border: 1px solid #fed7d7; border-radius: 8px; padding: 16px;">
      <h3 style="color: #c53030; margin: 0 0 12px 0; font-size: 15px;">
        🔴 Phòng đã quá hạn đóng tiền (${overdueRooms.length} phòng)
      </h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="background: #feb2b2; color: #742a2a; text-align: left;">
            <th style="padding: 8px 10px; border-radius: 4px 0 0 4px;">Phòng</th>
            <th style="padding: 8px 10px;">Khách thuê / SĐT</th>
            <th style="padding: 8px 10px;">Kỳ hạn</th>
            <th style="padding: 8px 10px;">Trễ hạn</th>
            <th style="padding: 8px 10px; text-align: right; border-radius: 0 4px 4px 0;">Tổng tiền</th>
          </tr>
        </thead>
        <tbody>
          ${overdueRooms.map((r, idx) => `
            <tr style="border-bottom: 1px solid #fed7d7; background: ${idx % 2 === 0 ? '#ffffff' : '#fffaf0'};">
              <td style="padding: 10px; font-weight: bold; color: #9b2c2c;">${r.room_code}</td>
              <td style="padding: 10px;">${r.tenant_names || 'Chưa cập nhật'} <br/><span style="color: #718096; font-size: 12px;">${r.tenant_phones || ''}</span></td>
              <td style="padding: 10px;">Ngày ${r.final_due_day}</td>
              <td style="padding: 10px;"><span style="background: #e53e3e; color: #ffffff; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: bold;">Trễ ${Math.abs(r.days_until_due)} ngày</span></td>
              <td style="padding: 10px; text-align: right; font-weight: bold; color: #c53030;">${formatVND(r.total_amount)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  ` : '';

  const dueTodaySection = dueTodayRooms.length > 0 ? `
    <div style="margin-bottom: 24px; background: #fffaf0; border: 1px solid #feebc8; border-radius: 8px; padding: 16px;">
      <h3 style="color: #dd6b20; margin: 0 0 12px 0; font-size: 15px;">
        🟡 Phòng đến hạn hôm nay (${dueTodayRooms.length} phòng)
      </h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="background: #fbd38d; color: #7b341e; text-align: left;">
            <th style="padding: 8px 10px; border-radius: 4px 0 0 4px;">Phòng</th>
            <th style="padding: 8px 10px;">Khách thuê / SĐT</th>
            <th style="padding: 8px 10px;">Kỳ hạn</th>
            <th style="padding: 8px 10px; text-align: right; border-radius: 0 4px 4px 0;">Tổng tiền</th>
          </tr>
        </thead>
        <tbody>
          ${dueTodayRooms.map((r, idx) => `
            <tr style="border-bottom: 1px solid #feebc8; background: ${idx % 2 === 0 ? '#ffffff' : '#fffaf0'};">
              <td style="padding: 10px; font-weight: bold; color: #c05621;">${r.room_code}</td>
              <td style="padding: 10px;">${r.tenant_names || 'Chưa cập nhật'} <br/><span style="color: #718096; font-size: 12px;">${r.tenant_phones || ''}</span></td>
              <td style="padding: 10px;">Hôm nay (Ngày ${r.final_due_day})</td>
              <td style="padding: 10px; text-align: right; font-weight: bold; color: #dd6b20;">${formatVND(r.total_amount)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  ` : '';

  const upcomingSection = upcomingRooms.length > 0 ? `
    <div style="margin-bottom: 24px; background: #ebf8ff; border: 1px solid #bee3f8; border-radius: 8px; padding: 16px;">
      <h3 style="color: #2b6cb0; margin: 0 0 12px 0; font-size: 15px;">
        🔵 Phòng sắp đến hạn (${upcomingRooms.length} phòng - Còn 1-3 ngày)
      </h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="background: #bee3f8; color: #2c5282; text-align: left;">
            <th style="padding: 8px 10px; border-radius: 4px 0 0 4px;">Phòng</th>
            <th style="padding: 8px 10px;">Khách thuê</th>
            <th style="padding: 8px 10px;">Kỳ hạn</th>
            <th style="padding: 8px 10px; text-align: right; border-radius: 0 4px 4px 0;">Tổng tiền</th>
          </tr>
        </thead>
        <tbody>
          ${upcomingRooms.map((r, idx) => `
            <tr style="border-bottom: 1px solid #bee3f8; background: ${idx % 2 === 0 ? '#ffffff' : '#f7fafc'};">
              <td style="padding: 10px; font-weight: bold; color: #2b6cb0;">${r.room_code}</td>
              <td style="padding: 10px;">${r.tenant_names || 'Chưa cập nhật'}</td>
              <td style="padding: 10px;">Ngày ${r.final_due_day} (Còn ${r.days_until_due} ngày)</td>
              <td style="padding: 10px; text-align: right; font-weight: bold; color: #2b6cb0;">${formatVND(r.total_amount)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  ` : '';

  const allUnpaidRooms = [...overdueRooms, ...dueTodayRooms, ...upcomingRooms, ...otherUnpaidRooms];

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Báo cáo thu tiền nhà trọ</title>
    </head>
    <body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #334155;">
      <div style="max-width: 650px; margin: 20px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">

        <!-- Header -->
        <div style="background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); padding: 24px; color: #ffffff; text-align: center;">
          <h1 style="margin: 0 0 6px 0; font-size: 20px; font-weight: 700; letter-spacing: 0.5px;">NHÀ TRỌ TIỆN NGHI</h1>
          <p style="margin: 0; font-size: 14px; color: #94a3b8;">📊 Báo cáo thu tiền & Nhắc hạn ngày <b>${dateStr}</b></p>
        </div>

        <div style="padding: 24px;">
          <!-- KPI Summary -->
          <div style="margin-bottom: 24px;">
            <table style="width: 100%; border-collapse: separate; border-spacing: 8px 0;">
              <tr>
                <td style="width: 33.33%; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 12px; text-align: center;">
                  <div style="font-size: 11px; font-weight: 600; color: #166534; text-transform: uppercase;">Đã thu (${paidCount}/${totalOccupied})</div>
                  <div style="font-size: 16px; font-weight: 700; color: #15803d; margin-top: 4px;">${formatVND(totalPaidMoney)}</div>
                </td>
                <td style="width: 33.33%; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 12px; text-align: center;">
                  <div style="font-size: 11px; font-weight: 600; color: #991b1b; text-transform: uppercase;">Còn nợ (${unpaidCount} phòng)</div>
                  <div style="font-size: 16px; font-weight: 700; color: #b91c1c; margin-top: 4px;">${formatVND(totalUnpaidMoney)}</div>
                </td>
                <td style="width: 33.33%; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; text-align: center;">
                  <div style="font-size: 11px; font-weight: 600; color: #475569; text-transform: uppercase;">Tổng dự thu</div>
                  <div style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 4px;">${formatVND(totalExpectedMoney)}</div>
                </td>
              </tr>
            </table>
          </div>

          <!-- Alert Sections -->
          ${overdueSection}
          ${dueTodaySection}
          ${upcomingSection}

          ${allUnpaidRooms.length === 0 ? `
            <div style="text-align: center; padding: 24px; background: #f0fdf4; border-radius: 8px; border: 1px solid #bbf7d0; color: #166534; margin-bottom: 24px;">
              <div style="font-size: 24px; margin-bottom: 6px;">🎉</div>
              <b>Tuyệt vời! Tất cả các phòng đã hoàn tất đóng tiền trọ tháng này!</b>
            </div>
          ` : ''}

          <!-- Danh sách phòng còn nợ -->
          ${allUnpaidRooms.length > 0 ? `
            <div style="margin-top: 24px;">
              <h3 style="font-size: 15px; color: #1e293b; margin-bottom: 12px; padding-bottom: 6px; border-bottom: 2px solid #e2e8f0;">
                📋 Danh sách chi tiết ${allUnpaidRooms.length} phòng chưa thu tiền
              </h3>
              <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                <thead>
                  <tr style="background: #f1f5f9; color: #475569; text-align: left;">
                    <th style="padding: 8px;">Phòng</th>
                    <th style="padding: 8px;">Khách đại diện</th>
                    <th style="padding: 8px;">Kỳ thu</th>
                    <th style="padding: 8px; text-align: right;">Tiền nhà</th>
                    <th style="padding: 8px; text-align: right;">Điện/D.vụ</th>
                    <th style="padding: 8px; text-align: right;">Tổng nợ</th>
                  </tr>
                </thead>
                <tbody>
                  ${allUnpaidRooms.map((r, idx) => {
                    const svc = r.elec_amount + r.water_amount + r.trash_amount + r.residence_amount + r.deposit_amount;
                    return `
                      <tr style="border-bottom: 1px solid #f1f5f9; background: ${idx % 2 === 0 ? '#ffffff' : '#fafafa'};">
                        <td style="padding: 8px; font-weight: bold; color: #0f172a;">${r.room_code}</td>
                        <td style="padding: 8px;">${r.tenant_names || 'Chưa cập nhật'}</td>
                        <td style="padding: 8px;">Ngày ${r.final_due_day}</td>
                        <td style="padding: 8px; text-align: right;">${formatVND(r.rent_amount)}</td>
                        <td style="padding: 8px; text-align: right;">${formatVND(svc)}</td>
                        <td style="padding: 8px; text-align: right; font-weight: bold; color: #e11d48;">${formatVND(r.total_amount)}</td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          ` : ''}

          <!-- Action Button -->
          <div style="text-align: center; margin-top: 28px; padding-top: 16px; border-top: 1px solid #e2e8f0;">
            <a href="https://quanlynhatro-10ar.onrender.com" target="_blank" style="display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 10px 24px; border-radius: 6px; font-weight: 600; font-size: 13px;">
              Mở Trang Quản Lý Nhà Trọ
            </a>
          </div>
        </div>

        <!-- Footer -->
        <div style="background: #f8fafc; padding: 14px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0;">
          Hệ thống Quản lý Nhà Trọ Tiện Nghi • Tự động gửi lúc 12:00 PM mỗi ngày
        </div>
      </div>
    </body>
    </html>
  `;
}

async function sendDailyReportEmail(force = false, customReceiver = null) {
  const settings = await db.prepare('SELECT key, value FROM settings').all();
  const settingsMap = {};
  settings.forEach(s => { settingsMap[s.key] = s.value; });

  const isEnabled = settingsMap.email_enabled === undefined || settingsMap.email_enabled === 'true' || settingsMap.email_enabled === '1' || settingsMap.email_enabled === 1 || settingsMap.email_enabled === true;
  if (!isEnabled && !force) {
    return { skipped: true, reason: 'Chức năng tự động gửi email đang bị tắt trong cài đặt.' };
  }

  const sender = settingsMap.email_sender || DEFAULT_EMAIL_SENDER;
  const pass = settingsMap.email_pass || DEFAULT_EMAIL_PASS;
  const receiver = (customReceiver && customReceiver.trim()) || settingsMap.email_receiver || DEFAULT_EMAIL_RECEIVER || sender;

  if (!sender || !pass) {
    return { error: 'Chưa cấu hình Email người gửi hoặc Mật khẩu ứng dụng (App Password)!' };
  }

  const vnDate = getVietnamDate();
  const todayStr = vnDate.dateStr;

  if (!force && settingsMap.last_email_sent_date === todayStr) {
    return { skipped: true, reason: `Báo cáo ngày ${todayStr} đã được gửi trước đó.` };
  }

  const reportData = await getDailyReportData(settingsMap, vnDate);
  const emailHtml = generateDailyEmailHTML(reportData);

  const transporter = createEmailTransporter(sender, pass);

  const overdueCount = reportData.overdueRooms.length;
  const dueTodayCount = reportData.dueTodayRooms.length;
  let subjectPrefix = '📊 [Báo cáo thu tiền]';
  if (overdueCount > 0) {
    subjectPrefix = `🔴 [Có ${overdueCount} phòng quá hạn]`;
  } else if (dueTodayCount > 0) {
    subjectPrefix = `🟡 [Có ${dueTodayCount} phòng đến hạn hôm nay]`;
  }

  await transporter.sendMail({
    from: `"Nhà Trọ Tiện Nghi" <${sender.trim()}>`,
    to: receiver.trim(),
    subject: `${subjectPrefix} Tổng kết ngày ${vnDate.day}/${vnDate.month}/${vnDate.year}`,
    html: emailHtml
  });

  await upsertSetting('last_email_sent_date', todayStr);

  return { success: true, message: `Đã gửi báo cáo ngày ${todayStr} tới ${receiver}`, reportData };
}

// Endpoint gửi email test kết nối SMTP
app.post('/api/settings/test-email', async (req, res) => {
  try {
    const settings = await db.prepare('SELECT key, value FROM settings').all();
    const settingsMap = {};
    settings.forEach(s => { settingsMap[s.key] = s.value; });

    const sender = settingsMap.email_sender || DEFAULT_EMAIL_SENDER;
    const pass = settingsMap.email_pass || DEFAULT_EMAIL_PASS;
    const reqReceiver = req.body?.email_receiver || req.body?.receiver;
    const receiver = (reqReceiver && reqReceiver.trim()) || settingsMap.email_receiver || DEFAULT_EMAIL_RECEIVER || sender;

    if (reqReceiver && reqReceiver.trim() && reqReceiver.trim() !== settingsMap.email_receiver) {
      await upsertSetting('email_receiver', reqReceiver.trim());
    }

    if (!sender || !pass) {
      return res.status(400).json({ error: 'Chưa cấu hình Email người gửi hoặc Mật khẩu ứng dụng (App Password)!' });
    }

    const transporter = createEmailTransporter(sender, pass);
    await transporter.verify();

    await transporter.sendMail({
      from: `"Nhà Trọ Tiện Nghi" <${sender.trim()}>`,
      to: receiver.trim(),
      subject: '✅ [Nhà Trọ] Kiểm tra kết nối Gmail thành công!',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 500px; margin: auto; border: 1px solid #e2e8f0; border-radius: 8px;">
          <h2 style="color: #2563eb; margin-top: 0;">🎉 Kết nối Gmail thành công!</h2>
          <p>Hệ thống Quản lý Nhà Trọ Tiện Nghi đã kết nối thành công với tài khoản Gmail của bạn.</p>
          <p>Từ bây giờ, hệ thống sẽ tự động tổng hợp báo cáo thu tiền và nhắc nhở phòng quá hạn gửi về email này hàng ngày lúc 12:00 trưa.</p>
          <div style="background: #f8fafc; padding: 12px; border-radius: 6px; font-size: 13px; color: #64748b; margin-top: 16px;">
            <b>Thời gian gửi:</b> ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}<br/>
            <b>Email phát tán:</b> ${sender}<br/>
            <b>Email nhận:</b> ${receiver}
          </div>
        </div>
      `
    });

    res.json({ message: `Đã gửi email test thành công đến ${receiver}!` });
  } catch (err) {
    let errMsg = err.message;
    if (err.responseCode === 535 || err.message.includes('Invalid login') || err.message.includes('Username and Password not accepted')) {
      errMsg = 'Xác thực Gmail thất bại (Mã 535). Vui lòng kiểm tra lại Email và Mật khẩu ứng dụng (Google App Password 16 ký tự, không phải mật khẩu đăng nhập thông thường). Đảm bảo tài khoản Gmail đã bật Xác minh 2 bước!';
    }
    res.status(500).json({ error: errMsg });
  }
});

// Endpoint gửi ngay báo cáo thu tiền
app.post('/api/settings/send-report-now', async (req, res) => {
  try {
    const reqReceiver = req.body?.email_receiver || req.body?.receiver;
    if (reqReceiver && reqReceiver.trim()) {
      await upsertSetting('email_receiver', reqReceiver.trim());
    }
    const result = await sendDailyReportEmail(true, reqReceiver);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ message: result.message || 'Đã gửi báo cáo thu tiền thành công!' });
  } catch (err) {
    let errMsg = err.message;
    if (err.responseCode === 535 || err.message.includes('Invalid login') || err.message.includes('Username and Password not accepted')) {
      errMsg = 'Xác thực Gmail thất bại. Vui lòng kiểm tra lại App Password 16 chữ số!';
    }
    res.status(500).json({ error: errMsg });
  }
});

// Webhook endpoint dành cho cron-job.org hoặc Render cron triggers
app.all('/api/cron/daily-report', async (req, res) => {
  try {
    console.log(`⏰ [CRON] Nhận webhook daily-report lúc ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`);
    const force = req.query.force === 'true';
    const result = await sendDailyReportEmail(force);
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      result
    });
  } catch (err) {
    console.error('❌ [CRON Error]:', err);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

function startDailyReportScheduler() {
  setInterval(async () => {
    try {
      const now = new Date();
      const vnTimeStr = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh' }); // HH:MM:SS
      const [hour, minute] = vnTimeStr.split(':').map(Number);

      // Trigger đúng 12:00 PM (12h trưa) giờ Việt Nam (hoặc 08:00 AM)
      if ((hour === 12 || hour === 8) && minute === 0) {
        console.log(`⏰ [Scheduler] ${hour}:00 VN Time - Đang tiến hành gửi email báo cáo tự động...`);
        const result = await sendDailyReportEmail(false);
        if (result.skipped) {
          console.log(`ℹ️ [Scheduler] Bỏ qua: ${result.reason}`);
        } else if (result.success) {
          console.log(`✅ [Scheduler] ${result.message}`);
        }
      }
    } catch (err) {
      console.error('❌ [Scheduler Error]:', err.message);
    }
  }, 60000);
}

// ==========================================
// 7. API TẠO HÓA ĐƠN
// ==========================================
app.get('/api/invoice', async (req, res) => {
  try {
    const { room_id, year, month } = req.query;
    if (!room_id || !year || !month) {
      return res.status(400).json({ error: 'Thiếu thông tin phòng, tháng hoặc năm' });
    }

    const room = await db.prepare('SELECT * FROM rooms WHERE id = ?').get(room_id);
    if (!room) return res.status(404).json({ error: 'Không tìm thấy phòng' });

    const tenants = await db.prepare(
      'SELECT full_name, phone FROM tenants WHERE room_id = ? ORDER BY id ASC'
    ).all(room_id);

    const elec = await db.prepare(
      'SELECT * FROM electricity_readings WHERE room_id = ? AND year = ? AND month = ?'
    ).get(room_id, parseInt(year), parseInt(month));

    const payment = await db.prepare(
      'SELECT * FROM rent_payments WHERE room_id = ? AND year = ? AND month = ?'
    ).get(room_id, parseInt(year), parseInt(month));

    // Lấy chỉ số tháng trước
    const prevMonth = parseInt(month) === 1 ? 12 : parseInt(month) - 1;
    const prevYear = parseInt(month) === 1 ? parseInt(year) - 1 : parseInt(year);
    const prevElec = await db.prepare(
      'SELECT new_reading FROM electricity_readings WHERE room_id = ? AND year = ? AND month = ?'
    ).get(room_id, prevYear, prevMonth);

    const settingsList = await db.prepare('SELECT * FROM settings').all();
    const settings = {};
    settingsList.forEach(s => { settings[s.key] = s.value; });

    // Xác định tháng đầu tiên, trả phòng
    const earliestTenant = await db.prepare('SELECT MIN(start_date) as start_date FROM tenants WHERE room_id = ?').get(room_id);
    const latestEndDate = await db.prepare('SELECT MAX(end_date) as end_date FROM tenants WHERE room_id = ? AND end_date IS NOT NULL').get(room_id);
    let isFirstMonth = false;
    let isCheckout = false;

    const waterPrice = parseFloat(settings['water_price']) || 20000;
    const trashPrice = parseFloat(settings['trash_price']) || 10000;
    const residencePrice = parseFloat(settings['residence_price']) || 50000;
    const memberCount = room.member_count || 0;

    let proratedRent = room.rent_price || 0;

    if (earliestTenant && earliestTenant.start_date) {
      const leaseDate = new Date(earliestTenant.start_date);
      if (!isNaN(leaseDate.getTime())) {
        const leaseYear = leaseDate.getFullYear();
        const leaseMonth = leaseDate.getMonth() + 1;
        const diffMonths = (parseInt(year) - leaseYear) * 12 + (parseInt(month) - leaseMonth);
        if (diffMonths === 0) {
          isFirstMonth = true;
          const billingDay = room.billing_day || 30;
          const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
          const endOfPeriod = Math.min(billingDay, lastDay);
          const startDay = leaseDate.getDate();
          const daysStayed = endOfPeriod - startDay + 1;
          if (daysStayed <= 0) {
            proratedRent = 0;
          } else if (daysStayed <= 15) {
            proratedRent = (room.rent_price || 0) / 2;
          } else {
            proratedRent = room.rent_price || 0;
          }
        } else if (diffMonths < 0) {
          proratedRent = 0;
        }
      }
    }

    if (latestEndDate && latestEndDate.end_date) {
      const ed = new Date(latestEndDate.end_date);
      if (!isNaN(ed.getTime())) {
        const edYear = ed.getFullYear();
        const edMonth = ed.getMonth() + 1;
        if (edYear === parseInt(year) && edMonth === parseInt(month)) {
          isCheckout = true;
          const dayOfMonth = ed.getDate();
          if (dayOfMonth <= 15) {
            proratedRent = (room.rent_price || 0) / 2;
          } else {
            proratedRent = room.rent_price || 0;
          }
        }
      }
    }

    const isPaidAlready = payment && payment.is_paid === 1;
    const rentAmount = isPaidAlready ? (payment.rent_amount || 0) : proratedRent;
    const elecAmount = isPaidAlready ? (payment.electricity_amount || 0) : (elec ? elec.total_cost : 0);
    const waterAmount = isPaidAlready ? (payment.water_amount || 0) : waterPrice * memberCount;
    const trashAmount = isPaidAlready ? (payment.trash_amount || 0) : trashPrice * memberCount;

    const includeResidenceParam = req.query.include_residence;
    let residenceAmount;
    if (includeResidenceParam === 'none') {
      residenceAmount = 0;
    } else if (includeResidenceParam === 'force') {
      residenceAmount = residencePrice * memberCount;
    } else if (isPaidAlready && payment.residence_amount !== null && payment.residence_amount !== undefined) {
      residenceAmount = payment.residence_amount;
    } else {
      residenceAmount = isFirstMonth ? residencePrice * memberCount : 0;
    }
    const depositAmount = isPaidAlready ? (payment.deposit_amount || 0) : (isFirstMonth ? (room.deposit || 0) : 0);
    const totalAmount = rentAmount + elecAmount + waterAmount + trashAmount + residenceAmount + depositAmount;

    // Lấy chỉ số điện mới nhất của phòng
    const latestElec = await db.prepare(
      'SELECT new_reading FROM electricity_readings WHERE room_id = ? ORDER BY year DESC, month DESC LIMIT 1'
    ).get(room_id);

    res.json({
      room,
      tenants,
      electricity: elec || null,
      prevElecReading: prevElec ? prevElec.new_reading : null,
      payment: payment || null,
      settings,
      summary: {
        rentAmount,
        elecAmount,
        waterAmount,
        trashAmount,
        residenceAmount,
        depositAmount,
        totalAmount,
        memberCount,
        waterPrice,
        trashPrice,
        residencePrice,
        month: parseInt(month),
        year: parseInt(year),
        isFirstMonth,
        isCheckout,
        isDepositMonth: isFirstMonth,
        currentElecIndex: latestElec ? latestElec.new_reading : 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 8. API TÌM KIẾM TOÀN CỤC
// ==========================================
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json({ tenants: [], rooms: [] });
    const kw = `%${q}%`;
    const tenantResults = await db.prepare(`
      SELECT t.*, r.room_code, r.zone FROM tenants t
      JOIN rooms r ON t.room_id = r.id
      WHERE t.full_name LIKE ? OR t.phone LIKE ? OR t.cccd LIKE ?
      ORDER BY r.room_code ASC
    `).all(kw, kw, kw);
    const roomResults = await db.prepare(
      'SELECT * FROM rooms WHERE room_code LIKE ? ORDER BY room_code ASC'
    ).all(kw);
    res.json({ tenants: tenantResults, room: roomResults });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// WEB ASSISTANT CHAT API
// ==========================================

// Endpoint chat với Trợ lý LISO trực tiếp trên Web
app.post('/api/assistant/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Nội dung tin nhắn không được để trống' });
    }
    const result = await assistant.executeCommand(message.trim());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`✅ Server đang chạy tại http://localhost:${PORT}`);

  assistant.setDb(db);
  startDailyReportScheduler();
});
