const express = require('express');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const db = require('./database');
const telegramBot = require('./telegramBot');

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
    
    // Bảo lưu số người do người dùng nhập thủ công (vì họ có thể chỉ đăng ký 1 người đại diện nhưng thực tế ở đông hơn)
    let finalMemberCount = parseInt(member_count) || 0;
    
    // Nếu phòng có người thuê trong DB nhưng số người nhập lại là 0, tự động đặt tối thiểu là 1
    if (actualCount > 0 && finalMemberCount === 0) {
      finalMemberCount = 1;
    }
    
    // Nếu trạng thái là trống (vacant), bắt buộc số người về 0
    if (status === 'vacant') {
      finalMemberCount = 0;
    }

    const finalStatus = finalMemberCount > 0 ? 'occupied' : status;
    const finalBillingDay = billing_day === 15 ? 15 : 30; // Chỉ chấp nhận 15 hoặc 30

    const info = await db.prepare(
      'UPDATE rooms SET rent_price = ?, deposit = ?, status = ?, member_count = ?, billing_day = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(rent_price, deposit, finalStatus, finalMemberCount, finalBillingDay, req.params.id);
    
    if (info.changes === 0) return res.status(404).json({ error: 'Không tìm thấy phòng' });
    res.json({ message: 'Cập nhật phòng thành công' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. API NGƯỜI THUÊ (TENANTS)
// ==========================================
app.post('/api/tenants', async (req, res) => {
  try {
    const { room_id, full_name, phone, cccd, start_date, end_date, notes } = req.body;
    if (!room_id || !full_name || !start_date)
      return res.status(400).json({ error: 'Vui lòng điền đầy đủ Họ tên và Ngày bắt đầu' });
    
    const info = await db.prepare(
      'INSERT INTO tenants (room_id, full_name, phone, cccd, start_date, end_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
    ).run(room_id, full_name, phone || null, cccd || null, start_date, end_date || null, notes || null);
    
    // Khi thêm người thuê mới: Đảm bảo trạng thái phòng chuyển thành 'occupied'.
    // Bảo lưu số người hiện có nếu đang > 0. Nếu đang là 0 thì đặt tối thiểu là 1.
    const room = await db.prepare('SELECT member_count FROM rooms WHERE id = ?').get(room_id);
    const currentMembers = room ? room.member_count : 0;
    const newMembers = currentMembers === 0 ? 1 : currentMembers;
    
    await db.prepare(
      "UPDATE rooms SET member_count = ?, status = 'occupied', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(newMembers, room_id);
    
    res.status(201).json({ id: info.lastInsertRowid, message: 'Thêm người thuê thành công' });
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
      // Nếu vẫn còn người thuê khác, giữ nguyên trạng thái occupied và bảo lưu số người ở thực tế hiện tại
      await db.prepare(
        "UPDATE rooms SET status = 'occupied', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(tenant.room_id);
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

    // Tháng trước để lấy chỉ số cũ
    const prevM = m === 1 ? 12 : m - 1;
    const prevY = m === 1 ? y - 1 : y;

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
          // Nếu thuê bắt đầu từ tháng này hoặc tương lai, thì không hiển thị trong danh sách thu tiền tháng này
          if (leaseYear > billingYear || (leaseYear === billingYear && leaseMonth >= billingMonth)) {
            return false;
          }
        }
      }
      return true;
    });

    // Gắn waterAmount, trashAmount, residenceAmount, depositAmount, computedTotal cho mỗi dòng
    const enrichedRows = filteredRows.map(row => {
      const memberCount = row.member_count || 0;
      const isPaid = row.is_paid === 1;

      // Xác định tháng bắt đầu hợp đồng (tháng đóng tiền cọc) và tháng tính tiền đầu tiên (tháng tiếp theo)
      let isFirstMonth = false;
      let isDepositMonth = false;
      if (row.lease_start_date) {
        const leaseDate = new Date(row.lease_start_date);
        if (!isNaN(leaseDate.getTime())) {
          const leaseYear = leaseDate.getFullYear();
          const leaseMonth = leaseDate.getMonth() + 1;
          const diffMonths = (parseInt(year) - leaseYear) * 12 + (parseInt(month) - leaseMonth);
          if (diffMonths === 1) {
            isFirstMonth = true;
          }
          if (diffMonths === 0) {
            isDepositMonth = true;
          }
        }
      }

      // Nếu chưa thu tiền (isPaid = false), luôn tính lại theo số người ở hiện tại và đơn giá cài đặt mới
      const rentAmt = (isPaid && row.rent_amount !== null && row.rent_amount !== undefined)
        ? row.rent_amount
        : (isDepositMonth ? 0 : (row.rent_price || 0));
      const waterAmt = (isPaid && row.water_amount !== null && row.water_amount !== undefined)
        ? row.water_amount
        : (isDepositMonth ? 0 : waterPrice * memberCount);
      const trashAmt = (isPaid && row.trash_amount !== null && row.trash_amount !== undefined)
        ? row.trash_amount
        : (isDepositMonth ? 0 : trashPrice * memberCount);
      const residenceAmt = (isPaid && row.residence_amount !== null && row.residence_amount !== undefined)
        ? row.residence_amount
        : (isFirstMonth ? residencePrice * memberCount : 0);
      const depositAmt = (isPaid && row.deposit_amount !== null && row.deposit_amount !== undefined)
        ? row.deposit_amount
        : (isDepositMonth ? (row.deposit || 0) : 0);

      return { 
        ...row, 
        rent_price: rentAmt,
        water_amount: waterAmt, 
        trash_amount: trashAmt, 
        residence_amount: residenceAmt, 
        deposit_amount: depositAmt,
        waterPrice, 
        trashPrice, 
        residencePrice 
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

    // Kiểm tra tháng đầu tiên thu tiền
    const earliestTenant = await db.prepare('SELECT MIN(start_date) as start_date FROM tenants WHERE room_id = ?').get(room_id);
    let isFirstMonth = false;
    let isDepositMonth = false;
    if (earliestTenant && earliestTenant.start_date) {
      const leaseDate = new Date(earliestTenant.start_date);
      if (!isNaN(leaseDate.getTime())) {
        const leaseYear = leaseDate.getFullYear();
        const leaseMonth = leaseDate.getMonth() + 1;
        const diffMonths = (parseInt(year) - leaseYear) * 12 + (parseInt(month) - leaseMonth);
        if (diffMonths === 1) {
          isFirstMonth = true;
        }
        if (diffMonths === 0) {
          isDepositMonth = true;
        }
      }
    }

    const rentAmount = isDepositMonth ? 0 : (room.rent_price || 0);
    const elecAmount = isDepositMonth ? 0 : (elec ? elec.total_cost : 0);
    const waterAmount = isDepositMonth ? 0 : (waterPrice * memberCount);
    const trashAmount = isDepositMonth ? 0 : (trashPrice * memberCount);
    const residenceAmount = isFirstMonth ? (residencePrice * memberCount) : 0;
    const depositAmount = isDepositMonth ? (room.deposit || 0) : 0;
    const totalAmount = rentAmount + elecAmount + waterAmount + trashAmount + residenceAmount + depositAmount;
    const paidAt = is_paid ? new Date().toISOString() : null;
    const finalBillingDay = room.billing_day || 30;

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

app.put('/api/settings', async (req, res) => {
  try {
    const { 
      electricity_price, water_price, trash_price, residence_price, payment_due_day, 
      bank_name, bank_account, bank_owner,
      email_sender, email_pass, email_receiver, email_enabled
    } = req.body;
    
    const upsertSetting = async (key, val) => {
      if (val !== undefined && val !== null) {
        await db.prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP"
        ).run(key, val.toString());
      }
    };

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

    // Get previous month electricity (for old reading display)
    const prevMonth = parseInt(month) === 1 ? 12 : parseInt(month) - 1;
    const prevYear = parseInt(month) === 1 ? parseInt(year) - 1 : parseInt(year);
    const prevElec = await db.prepare(
      'SELECT new_reading FROM electricity_readings WHERE room_id = ? AND year = ? AND month = ?'
    ).get(room_id, prevYear, prevMonth);

    const settingsList = await db.prepare('SELECT * FROM settings').all();
    const settings = {};
    settingsList.forEach(s => { settings[s.key] = s.value; });

    // Kiểm tra xem có phải tháng đầu tiên hoặc tháng bắt đầu thuê không
    const earliestTenant = await db.prepare('SELECT MIN(start_date) as start_date FROM tenants WHERE room_id = ?').get(room_id);
    let isFirstMonth = false;
    let isDepositMonth = false;
    let isExcludedMonth = false;
    if (earliestTenant && earliestTenant.start_date) {
      const leaseDate = new Date(earliestTenant.start_date);
      if (!isNaN(leaseDate.getTime())) {
        const leaseYear = leaseDate.getFullYear();
        const leaseMonth = leaseDate.getMonth() + 1;
        const diffMonths = (parseInt(year) - leaseYear) * 12 + (parseInt(month) - leaseMonth);
        if (diffMonths === 1) {
          isFirstMonth = true;
        } else if (diffMonths === 0) {
          isDepositMonth = true;
        } else if (diffMonths < 0) {
          isExcludedMonth = true;
        }
      }
    }

    const rentAmount = (isExcludedMonth || isDepositMonth) && (!payment || payment.is_paid !== 1) ? 0 : (room.rent_price || 0);
    const elecAmount = (isExcludedMonth || isDepositMonth) && (!payment || payment.is_paid !== 1) ? 0 : (elec ? elec.total_cost : 0);

    // Lấy giá nước/rác/tạm trú
    const waterPrice = parseFloat(settings['water_price']) || 20000;
    const trashPrice = parseFloat(settings['trash_price']) || 10000;
    const residencePrice = parseFloat(settings['residence_price']) || 50000;
    const memberCount = room.member_count || 0; // Sửa lỗi ở đây: Sử dụng room.member_count thực tế thay vì đếm số tenants

    const waterAmount = (isExcludedMonth || isDepositMonth) && (!payment || payment.is_paid !== 1) ? 0 : (payment ? (payment.water_amount || 0) : waterPrice * memberCount);
    const trashAmount = (isExcludedMonth || isDepositMonth) && (!payment || payment.is_paid !== 1) ? 0 : (payment ? (payment.trash_amount || 0) : trashPrice * memberCount);
    const residenceAmount = (isExcludedMonth || isDepositMonth) && (!payment || payment.is_paid !== 1) ? 0 : (payment ? (payment.residence_amount || 0) : (isFirstMonth ? residencePrice * memberCount : 0));
    const depositAmount = isExcludedMonth && (!payment || payment.is_paid !== 1) ? 0 : (payment ? (payment.deposit_amount || 0) : (isDepositMonth ? (room.deposit || 0) : 0));
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
        isDepositMonth,
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
// 9. GỬI BÁO CÁO NHẮC NỢ QUA EMAIL ✉️
// ==========================================

async function sendDailyEmailNotification(force = false) {
  try {
    // 1. Lấy cài đặt từ database settings
    const list = await db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    list.forEach(s => { settings[s.key] = s.value; });

    const enabled = settings['email_enabled'] === 'true';
    const sender = settings['email_sender'];
    const pass = settings['email_pass'];
    const receiver = settings['email_receiver'];

    if (!force) {
      if (!enabled || !sender || !pass || !receiver) return;

      // Kiểm tra xem hôm nay đã gửi chưa (theo múi giờ Việt Nam UTC+7)
      const nowVN = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
      const todayStr = `${nowVN.getFullYear()}-${nowVN.getMonth() + 1}-${nowVN.getDate()}`;
      
      if (settings['last_email_sent_date'] === todayStr) {
        return; // Hôm nay đã gửi báo cáo rồi
      }

      // Chỉ kiểm tra và gửi vào lúc 8h sáng
      const hour = nowVN.getHours();
      if (hour !== 8) {
        return;
      }
    } else {
      if (!sender || !pass || !receiver) {
        throw new Error("Thiếu cấu hình Gmail: Vui lòng điền đầy đủ email gửi, mật khẩu ứng dụng và email nhận.");
      }
    }

    const nowVN = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
    const todayStr = `${nowVN.getFullYear()}-${nowVN.getMonth() + 1}-${nowVN.getDate()}`;

    // 2. Lấy dữ liệu phòng trọ chưa đóng tiền
    const currentMonth = nowVN.getMonth() + 1;
    const currentYear = nowVN.getFullYear();
    const todayStart = new Date(nowVN.getFullYear(), nowVN.getMonth(), nowVN.getDate());

    const waterPrice = parseFloat(settings['water_price']) || 20000;
    const trashPrice = parseFloat(settings['trash_price']) || 10000;
    const residencePrice = parseFloat(settings['residence_price']) || 50000;

    const rows = await db.prepare(`
      SELECT 
        r.id as room_id,
        r.room_code,
        r.deposit,
        r.billing_day,
        COALESCE(p.rent_amount, r.rent_price) as rent_price,
        r.status as room_status,
        r.member_count,
        (SELECT MIN(start_date) FROM tenants WHERE room_id = r.id) as lease_start_date,
        COALESCE(p.tenant_name, STRING_AGG(t.full_name, ', ')) as tenant_names,
        COALESCE(p.electricity_amount, e.total_cost) as electricity_amount,
        p.is_paid,
        p.water_amount,
        p.trash_amount,
        p.residence_amount,
        p.deposit_amount,
        p.total_amount
      FROM rooms r
      LEFT JOIN tenants t ON t.room_id = r.id
      LEFT JOIN electricity_readings e ON e.room_id = r.id AND e.year = ? AND e.month = ?
      LEFT JOIN rent_payments p ON p.room_id = r.id AND p.year = ? AND p.month = ?
      WHERE r.status = 'occupied' OR p.id IS NOT NULL OR e.id IS NOT NULL
      GROUP BY r.id, p.id, e.id
    `).all(currentYear, currentMonth, currentYear, currentMonth);

    // Tính toán và lọc danh sách phòng cần gửi mail (chưa thanh toán & còn <= 3 ngày đến hạn hoặc quá hạn)
    const dueRooms = [];
    for (const row of rows) {
      if (row.is_paid === 1 || row.room_status !== 'occupied') continue;

      let isFirstMonth = false;
      let isDepositMonth = false;
      let isExcludedMonth = false;
      if (row.lease_start_date) {
        const leaseDate = new Date(row.lease_start_date);
        if (!isNaN(leaseDate.getTime())) {
          const leaseYear = leaseDate.getFullYear();
          const leaseMonth = leaseDate.getMonth() + 1;
          const diffMonths = (currentYear - leaseYear) * 12 + (currentMonth - leaseMonth);
          if (diffMonths === 1) {
            isFirstMonth = true;
          } else if (diffMonths === 0) {
            isDepositMonth = true;
          } else if (diffMonths < 0) {
            isExcludedMonth = true;
          }
        }
      }

      // Không gửi email thông báo nợ đối với phòng ở tháng cọc đầu tiên hoặc chưa dời vào
      if (isDepositMonth || isExcludedMonth) continue;

      const rentAmt = row.rent_price || 0;
      const elecAmt = row.electricity_amount || 0;
      const memberCount = row.member_count || 0;
      const waterAmt = row.water_amount !== null && row.water_amount !== undefined ? row.water_amount : waterPrice * memberCount;
      const trashAmt = row.trash_amount !== null && row.trash_amount !== undefined ? row.trash_amount : trashPrice * memberCount;
      const residenceAmt = row.residence_amount !== null && row.residence_amount !== undefined ? row.residence_amount : (isFirstMonth ? residencePrice * memberCount : 0);
      const depositAmt = row.deposit_amount !== null && row.deposit_amount !== undefined ? row.deposit_amount : 0;
      const totalAmt = rentAmt + elecAmt + waterAmt + trashAmt + residenceAmt + depositAmt;

      // Tính ngày hạn dựa vào billing_day của phòng (15 hoặc 30)
      let dueDay = row.billing_day || 30;
      const lastDay = new Date(currentYear, currentMonth, 0).getDate();
      const finalDay = Math.min(dueDay, lastDay);
      const dueDate = new Date(currentYear, currentMonth - 1, finalDay);
      const diffTime = dueDate - todayStart;
      const daysUntilDue = Math.round(diffTime / (1000 * 60 * 60 * 24));

      if (daysUntilDue <= 15) {
        dueRooms.push({
          room_code: row.room_code,
          tenant_name: row.tenant_names || 'Chưa có người thuê',
          total_amount: totalAmt,
          daysUntilDue,
          dueDateStr: `${finalDay}/${currentMonth}/${currentYear}`
        });
      }
    }

    if (dueRooms.length === 0 && !force) {
      console.log(`[Email] Hôm nay ${todayStr} không có phòng nào sắp đến hạn/quá hạn nợ.`);
      return;
    }

    // 3. Tiến hành gửi mail qua nodemailer
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: sender,
        pass: pass
      }
    });

    let mailSubject = `[Nhà Trọ LISO] 🔔 Báo cáo nhắc nợ tiền trọ ngày ${todayStr}`;
    let mailBody = `
      <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
        <h2 style="color: #2b6cb0; margin-top: 0;">🏠 Nhà Trọ LISO - Báo cáo nợ tiền phòng</h2>
        <p style="font-size: 14px; color: #4a5568;">Xin chào chủ nhà trọ, đây là danh sách tổng hợp các phòng sắp đến hạn đóng tiền hoặc đã quá hạn đóng tiền ngày <strong>${todayStr}</strong>:</p>
    `;
    
    if (dueRooms.length > 0) {
      mailBody += `
        <table border="1" cellpadding="10" cellspacing="0" style="border-collapse: collapse; width: 100%; font-size: 14px; border: 1px solid #cbd5e0; margin-bottom: 20px;">
          <thead>
            <tr style="background-color: #f7fafc;">
              <th align="left">Phòng</th>
              <th align="left">Khách thuê</th>
              <th align="left">Hạn đóng</th>
              <th align="left">Trạng thái</th>
              <th align="right">Số tiền</th>
            </tr>
          </thead>
          <tbody>
      `;

      dueRooms.forEach(room => {
        let statusText = '';
        let statusColor = '#3182ce'; // Xanh dương
        if (room.daysUntilDue > 0) {
          statusText = `⏳ Còn ${room.daysUntilDue} ngày`;
          statusColor = '#dd6b20'; // Cam
        } else if (room.daysUntilDue === 0) {
          statusText = `🚨 Đến hạn hôm nay`;
          statusColor = '#e53e3e'; // Đỏ
        } else {
          statusText = `⚠️ Quá hạn ${Math.abs(room.daysUntilDue)} ngày`;
          statusColor = '#e53e3e'; // Đỏ
        }

        mailBody += `
          <tr>
            <td><strong>Phòng ${room.room_code}</strong></td>
            <td>${room.tenant_name}</td>
            <td>${room.dueDateStr}</td>
            <td style="color: ${statusColor}; font-weight: bold; font-size: 13px;">${statusText}</td>
            <td align="right" style="color: #2d3748; font-weight: bold;">${room.total_amount.toLocaleString('vi-VN')}đ</td>
          </tr>
        `;
      });
      mailBody += `
          </tbody>
        </table>
      `;
    } else {
      mailBody += `<p style="color: #38a169; font-weight: bold; font-size: 14px; padding: 10px; background: #f0fff4; border-radius: 6px; border: 1px solid #c6f6d5;">✅ Tuyệt vời! Không có phòng nào sắp đến hạn hay quá hạn đóng tiền trong hôm nay.</p>`;
    }

    mailBody += `
        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
        <p style="font-size: 12px; color: #718096; text-align: center; margin-bottom: 0;">Email này được gửi tự động từ hệ thống quản lý nhà trọ LISO của bạn.<br>Vui lòng duy trì UptimeRobot để tính năng này luôn hoạt động đúng giờ.</p>
      </div>
    `;

    await transporter.sendMail({
      from: `"Nhà Trọ LISO" <${sender}>`,
      to: receiver,
      subject: mailSubject,
      html: mailBody
    });

    // 4. Cập nhật ngày gửi thành công vào cài đặt
    await db.prepare(
      "INSERT INTO settings (key, value) VALUES ('last_email_sent_date', ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP"
    ).run(todayStr);

    console.log(`[Email] Đã gửi báo cáo tự động thành công cho ngày ${todayStr}`);
  } catch (err) {
    console.error('[Email Error] Thất bại khi gửi email thông báo:', err);
    if (force) throw err;
  }
}

// ==========================================
// TELEGRAM BOT API
// ==========================================

// Lấy cấu hình bot hiện tại
app.get('/api/telegram/status', async (req, res) => {
  try {
    const tokenRow = await db.prepare("SELECT value FROM settings WHERE key = 'telegram_bot_token'").get();
    const chatIdRow = await db.prepare("SELECT value FROM settings WHERE key = 'telegram_admin_chat_id'").get();
    const status = telegramBot.getBotStatus();
    res.json({
      hasToken: !!(tokenRow && tokenRow.value),
      hasChatId: !!(chatIdRow && chatIdRow.value),
      running: status.running,
      // Mà hoá token để hiển thị an toàn (chỉ hiện 10 ký tự đầu)
      tokenPreview: tokenRow?.value ? tokenRow.value.substring(0, 12) + '...' : null,
      adminChatId: chatIdRow?.value || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lưu cấu hình và khởi động bot
app.post('/api/telegram/connect', async (req, res) => {
  try {
    const { token, adminChatId } = req.body;
    if (!token || !adminChatId) {
      return res.status(400).json({ error: 'Cần có Bot Token và Admin Chat ID' });
    }

    // Lưu vào settings
    await db.prepare("INSERT INTO settings (key, value) VALUES ('telegram_bot_token', ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP").run(token.trim());
    await db.prepare("INSERT INTO settings (key, value) VALUES ('telegram_admin_chat_id', ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP").run(String(adminChatId).trim());

    // Khởi động bot
    const result = await telegramBot.startBot(token.trim(), String(adminChatId).trim(), db);
    if (result.ok) {
      res.json({ message: `✅ Bot @${result.botName} đã kết nối thành công!`, botName: result.botName });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ngắt kết nối bot
app.post('/api/telegram/disconnect', async (req, res) => {
  try {
    await telegramBot.stopBot();
    res.json({ message: '🔴 Bot đã ngắt kết nối' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint gửi thử Gmail test
app.post('/api/settings/test-email', async (req, res) => {
  try {
    await sendDailyEmailNotification(true);
    res.json({ message: '✅ Đã gửi email thử nghiệm thành công! Vui lòng kiểm tra hộp thư của bạn (bao gồm cả thư rác/spam).' });
  } catch (err) {
    res.status(500).json({ error: `Gửi email thất bại: ${err.message}` });
  }
});

// Lập trình kiểm tra gửi email tự động (Cứ mỗi 15 phút chạy 1 lần để check lúc 8h sáng)
setTimeout(() => {
  sendDailyEmailNotification().catch(console.error);
}, 10000); // Chạy thử lần đầu 10 giây sau khi khởi động

setInterval(() => {
  sendDailyEmailNotification().catch(console.error);
}, 15 * 60 * 1000); // Kiểm tra lại sau mỗi 15 phút

app.listen(PORT, async () => {
  console.log(`✅ Server đang chạy tại http://localhost:${PORT}`);

  // Tự động khởi động Telegram Bot nếu đã có token trong cài đặt
  try {
    const tokenRow = await db.prepare("SELECT value FROM settings WHERE key = 'telegram_bot_token'").get();
    const chatIdRow = await db.prepare("SELECT value FROM settings WHERE key = 'telegram_admin_chat_id'").get();
    if (tokenRow?.value && chatIdRow?.value) {
      const result = await telegramBot.startBot(tokenRow.value, chatIdRow.value, db);
      if (result.ok) {
        console.log(`✅ Telegram Bot @${result.botName} đã tự động kết nối!`);
      } else {
        console.warn(`⚠️ Không thể kết nối Telegram Bot: ${result.error}`);
      }
    }
  } catch (e) {
    console.warn('⚠️ Telegram Bot không khởi động được:', e.message);
  }
});

