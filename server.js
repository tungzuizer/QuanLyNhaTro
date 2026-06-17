const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

    const paymentStats = await db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN is_paid = 1 THEN 1 ELSE 0 END) as paid_count,
        SUM(CASE WHEN is_paid = 0 THEN 1 ELSE 0 END) as unpaid_count,
        SUM(CASE WHEN is_paid = 1 THEN total_amount ELSE 0 END) as collected,
        SUM(CASE WHEN is_paid = 0 THEN total_amount ELSE 0 END) as pending
      FROM rent_payments WHERE year = ? AND month = ?
    `).get(currentYear, currentMonth);

    res.json({
      totalRooms, occupiedRooms, vacantRooms, maintenanceRooms,
      totalRentCost,
      totalElectricityCost: totalElectricityCost > 0 ? totalElectricityCost : prevMonthElec,
      electricityMonth: totalElectricityCost > 0 ? currentMonth : prevMonth,
      electricityYear: totalElectricityCost > 0 ? currentYear : prevYear,
      paymentStats: {
        total: paymentStats ? (paymentStats.total || 0) : 0,
        paidCount: paymentStats ? (paymentStats.paid_count || 0) : 0,
        unpaidCount: paymentStats ? (paymentStats.unpaid_count || 0) : 0,
        collected: paymentStats ? (paymentStats.collected || 0) : 0,
        pending: paymentStats ? (paymentStats.pending || 0) : 0
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
    const { rent_price, deposit, status } = req.body;
    const info = await db.prepare(
      'UPDATE rooms SET rent_price = ?, deposit = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(rent_price, deposit, status, req.params.id);
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
    await db.prepare(
      "UPDATE rooms SET member_count = member_count + 1, status = CASE WHEN status = 'vacant' THEN 'occupied' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(room_id);
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
    await db.prepare('UPDATE rooms SET member_count = MAX(0, member_count - 1), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(tenant.room_id);
    const room = await db.prepare('SELECT member_count, status FROM rooms WHERE id = ?').get(tenant.room_id);
    if (room && room.member_count === 0 && room.status === 'occupied')
      await db.prepare("UPDATE rooms SET status = 'vacant' WHERE id = ?").run(tenant.room_id);
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
      SET electricity_amount = ?, total_amount = rent_amount + ?, updated_at = CURRENT_TIMESTAMP
      WHERE room_id = ? AND year = ? AND month = ?
    `).run(totalCost, totalCost, room_id, parseInt(year), parseInt(month));

    res.json({ message: 'Lưu chỉ số điện thành công', consumption, totalCost });
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

    const rows = await db.prepare(`
      SELECT 
        r.id as room_id,
        r.room_code,
        r.zone,
        COALESCE(p.rent_amount, r.rent_price) as rent_price,
        r.status as room_status,
        r.member_count,
        COALESCE(p.tenant_name, STRING_AGG(t.full_name, ', ')) as tenant_names,
        STRING_AGG(t.phone, ', ') as tenant_phones,
        COALESCE(p.electricity_amount, e.total_cost) as electricity_amount,
        e.consumption,
        p.id as payment_id,
        p.is_paid,
        p.rent_amount,
        p.electricity_amount as p_elec_amount,
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

    res.json(rows);
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

    const room = await db.prepare('SELECT rent_price FROM rooms WHERE id = ?').get(room_id);
    if (!room) return res.status(404).json({ error: 'Không tìm thấy phòng' });

    const elec = await db.prepare(
      'SELECT total_cost FROM electricity_readings WHERE room_id = ? AND year = ? AND month = ?'
    ).get(room_id, parseInt(year), parseInt(month));

    const tenants = await db.prepare('SELECT full_name FROM tenants WHERE room_id = ?').all(room_id);
    const tenantName = tenants.map(t => t.full_name).join(', ') || null;

    const rentAmount = room.rent_price || 0;
    const elecAmount = elec ? elec.total_cost : 0;
    const totalAmount = rentAmount + elecAmount;
    const paidAt = is_paid ? new Date().toISOString() : null;

    await db.prepare(`
      INSERT INTO rent_payments (room_id, year, month, rent_amount, electricity_amount, total_amount, is_paid, paid_at, note, tenant_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id, year, month) DO UPDATE SET
        rent_amount = EXCLUDED.rent_amount,
        electricity_amount = EXCLUDED.electricity_amount,
        total_amount = EXCLUDED.total_amount,
        is_paid = EXCLUDED.is_paid,
        paid_at = EXCLUDED.paid_at,
        note = EXCLUDED.note,
        tenant_name = COALESCE(EXCLUDED.tenant_name, rent_payments.tenant_name),
        updated_at = CURRENT_TIMESTAMP
    `).run(room_id, parseInt(year), parseInt(month), rentAmount, elecAmount, totalAmount, is_paid ? 1 : 0, paidAt, note || null, tenantName);

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
    const { electricity_price } = req.body;
    if (electricity_price === undefined)
      return res.status(400).json({ error: 'Thiếu giá trị điện năng' });
    await db.prepare(
      "INSERT INTO settings (key, value) VALUES ('electricity_price', ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP"
    ).run(electricity_price.toString());
    res.json({ message: 'Cập nhật giá điện thành công' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 7. API TÌM KIẾM TOÀN CỤC
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

app.listen(PORT, () => {
  console.log(`✅ Server đang chạy tại http://localhost:${PORT}`);
});
