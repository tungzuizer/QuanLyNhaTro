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

// Route ping nháº¹ Ä‘á»ƒ giá»¯ server luĂ´n thá»©c trĂªn Render
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

    // Láº¥y giĂ¡ nÆ°á»›c/rĂ¡c/táº¡m trĂº tá»« settings
    const settingsList = await db.prepare('SELECT key, value FROM settings WHERE key IN (?, ?, ?, ?)').all('water_price', 'trash_price', 'electricity_price', 'residence_price');
    const settingsMap = {};
    settingsList.forEach(s => { settingsMap[s.key] = parseFloat(s.value) || 0; });
    const waterPrice = settingsMap['water_price'] || 20000;
    const trashPrice = settingsMap['trash_price'] || 10000;
    const residencePrice = settingsMap['residence_price'] || 50000;

    // TĂ­nh toĂ¡n sá»‘ liá»‡u thu tiá»n Ä‘á»“ng bá»™ 100% vá»›i tab danh sĂ¡ch thu tiá»n
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
          // Náº¿u thuĂª báº¯t Ä‘áº§u tá»« thĂ¡ng nĂ y hoáº·c tÆ°Æ¡ng lai, vĂ  chÆ°a thanh toĂ¡n, thĂ¬ khĂ´ng tĂ­nh tiá»n thĂ¡ng nĂ y
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

      // XĂ¡c Ä‘á»‹nh thĂ¡ng Ä‘áº§u tiĂªn thu tiá»n (sau thĂ¡ng báº¯t Ä‘áº§u há»£p Ä‘á»“ng 1 thĂ¡ng)
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
// 2. API PHĂ’NG (ROOMS)
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
    if (!room) return res.status(404).json({ error: 'KhĂ´ng tĂ¬m tháº¥y phĂ²ng nĂ y' });
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
    
    // Náº¿u chuyá»ƒn tráº¡ng thĂ¡i thĂ nh trá»‘ng (vacant), tá»± Ä‘á»™ng xĂ³a sáº¡ch ngÆ°á»i thuĂª trong phĂ²ng
    if (status === 'vacant') {
      await db.prepare('DELETE FROM tenants WHERE room_id = ?').run(req.params.id);
    }
    
    // Äáº¿m sá»‘ lÆ°á»£ng ngÆ°á»i thuĂª thá»±c táº¿ Ä‘Äƒng kĂ½ trong DB
    const countResult = await db.prepare('SELECT COUNT(*) as count FROM tenants WHERE room_id = ?').get(req.params.id);
    const actualCount = countResult ? countResult.count : 0;
    
    // Báº£o lÆ°u sá»‘ ngÆ°á»i do ngÆ°á»i dĂ¹ng nháº­p thá»§ cĂ´ng (vĂ¬ há» cĂ³ thá»ƒ chá»‰ Ä‘Äƒng kĂ½ 1 ngÆ°á»i Ä‘áº¡i diá»‡n nhÆ°ng thá»±c táº¿ á»Ÿ Ä‘Ă´ng hÆ¡n)
    let finalMemberCount = parseInt(member_count) || 0;
    
    // Náº¿u phĂ²ng cĂ³ ngÆ°á»i thuĂª trong DB nhÆ°ng sá»‘ ngÆ°á»i nháº­p láº¡i lĂ  0, tá»± Ä‘á»™ng Ä‘áº·t tá»‘i thiá»ƒu lĂ  1
    if (actualCount > 0 && finalMemberCount === 0) {
      finalMemberCount = 1;
    }
    
    // Náº¿u tráº¡ng thĂ¡i lĂ  trá»‘ng (vacant), báº¯t buá»™c sá»‘ ngÆ°á»i vá» 0
    if (status === 'vacant') {
      finalMemberCount = 0;
    }

    const finalStatus = finalMemberCount > 0 ? 'occupied' : status;
    const finalBillingDay = billing_day === 15 ? 15 : 30; // Chá»‰ cháº¥p nháº­n 15 hoáº·c 30

    const info = await db.prepare(
      'UPDATE rooms SET rent_price = ?, deposit = ?, status = ?, member_count = ?, billing_day = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(rent_price, deposit, finalStatus, finalMemberCount, finalBillingDay, req.params.id);
    
    if (info.changes === 0) return res.status(404).json({ error: 'KhĂ´ng tĂ¬m tháº¥y phĂ²ng' });
    res.json({ message: 'Cáº­p nháº­t phĂ²ng thĂ nh cĂ´ng' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. API NGÆ¯á»œI THUĂ (TENANTS)
// ==========================================
app.post('/api/tenants', async (req, res) => {
  try {
    const { room_id, full_name, phone, cccd, start_date, end_date, notes } = req.body;
    if (!room_id || !full_name || !start_date)
      return res.status(400).json({ error: 'Vui lĂ²ng Ä‘iá»n Ä‘áº§y Ä‘á»§ Há» tĂªn vĂ  NgĂ y báº¯t Ä‘áº§u' });
    
    const info = await db.prepare(
      'INSERT INTO tenants (room_id, full_name, phone, cccd, start_date, end_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
    ).run(room_id, full_name, phone || null, cccd || null, start_date, end_date || null, notes || null);
    
    // Khi thĂªm ngÆ°á»i thuĂª má»›i: Äáº£m báº£o tráº¡ng thĂ¡i phĂ²ng chuyá»ƒn thĂ nh 'occupied'.
    // Báº£o lÆ°u sá»‘ ngÆ°á»i hiá»‡n cĂ³ náº¿u Ä‘ang > 0. Náº¿u Ä‘ang lĂ  0 thĂ¬ Ä‘áº·t tá»‘i thiá»ƒu lĂ  1.
    const room = await db.prepare('SELECT member_count FROM rooms WHERE id = ?').get(room_id);
    const currentMembers = room ? room.member_count : 0;
    const newMembers = currentMembers === 0 ? 1 : currentMembers;
    
    await db.prepare(
      "UPDATE rooms SET member_count = ?, status = 'occupied', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(newMembers, room_id);
    
    res.status(201).json({ id: info.lastInsertRowid, message: 'ThĂªm ngÆ°á»i thuĂª thĂ nh cĂ´ng' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tenants/:id', async (req, res) => {
  try {
    const { full_name, phone, cccd, start_date, end_date, notes } = req.body;
    if (!full_name || !start_date)
      return res.status(400).json({ error: 'Há» tĂªn vĂ  NgĂ y báº¯t Ä‘áº§u khĂ´ng Ä‘Æ°á»£c Ä‘á»ƒ trá»‘ng' });
    const info = await db.prepare(
      'UPDATE tenants SET full_name = ?, phone = ?, cccd = ?, start_date = ?, end_date = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(full_name, phone, cccd, start_date, end_date, notes, req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'KhĂ´ng tĂ¬m tháº¥y ngÆ°á»i thuĂª' });
    res.json({ message: 'Sá»­a thĂ´ng tin ngÆ°á»i thuĂª thĂ nh cĂ´ng' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tenants/:id', async (req, res) => {
  try {
    const tenant = await db.prepare('SELECT room_id FROM tenants WHERE id = ?').get(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'KhĂ´ng tĂ¬m tháº¥y ngÆ°á»i thuĂª' });
    
    await db.prepare('DELETE FROM tenants WHERE id = ?').run(req.params.id);
    
    // Kiá»ƒm tra sá»‘ lÆ°á»£ng ngÆ°á»i thuĂª cĂ²n láº¡i trong DB
    const countResult = await db.prepare('SELECT COUNT(*) as count FROM tenants WHERE room_id = ?').get(tenant.room_id);
    const actualCount = countResult ? countResult.count : 0;
    
    if (actualCount === 0) {
      // Náº¿u khĂ´ng cĂ²n báº¥t ká»³ ngÆ°á»i thuĂª Ä‘Äƒng kĂ½ nĂ o, Ä‘Æ°a tráº¡ng thĂ¡i phĂ²ng vá» trá»‘ng vĂ  sá»‘ ngÆ°á»i vá» 0
      await db.prepare(
        "UPDATE rooms SET member_count = 0, status = 'vacant', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(tenant.room_id);
    } else {
      // Náº¿u váº«n cĂ²n ngÆ°á»i thuĂª khĂ¡c, giá»¯ nguyĂªn tráº¡ng thĂ¡i occupied vĂ  báº£o lÆ°u sá»‘ ngÆ°á»i á»Ÿ thá»±c táº¿ hiá»‡n táº¡i
      await db.prepare(
        "UPDATE rooms SET status = 'occupied', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(tenant.room_id);
    }
    
    res.json({ message: 'XĂ³a ngÆ°á»i thuĂª thĂ nh cĂ´ng' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. API ÄIá»†N NÄ‚NG (ELECTRICITY)
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
      return res.status(400).json({ error: 'Thiáº¿u thĂ´ng tin báº¯t buá»™c' });
    if (parseFloat(new_reading) < parseFloat(old_reading))
      return res.status(400).json({ error: 'Chá»‰ sá»‘ má»›i khĂ´ng Ä‘Æ°á»£c nhá» hÆ¡n chá»‰ sá»‘ cÅ©' });

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

    // Äá»“ng bá»™ vá»›i báº£ng rent_payments náº¿u báº£n ghi thanh toĂ¡n cá»§a thĂ¡ng Ä‘Ă³ Ä‘Ă£ tá»“n táº¡i
    await db.prepare(`
      UPDATE rent_payments 
      SET electricity_amount = ?, total_amount = rent_amount + ? + water_amount + trash_amount + residence_amount + deposit_amount, updated_at = CURRENT_TIMESTAMP
      WHERE room_id = ? AND year = ? AND month = ?
    `).run(totalCost, totalCost, room_id, parseInt(year), parseInt(month));

    res.json({ message: 'LÆ°u chá»‰ sá»‘ Ä‘iá»‡n thĂ nh cĂ´ng', consumption, totalCost });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// API ÄIá»†N HĂ€NG LOáº T (BULK ELECTRICITY)
// ==========================================

// Láº¥y dá»¯ liá»‡u bulk: danh sĂ¡ch phĂ²ng + chá»‰ sá»‘ cÅ© gáº§n nháº¥t + chá»‰ sá»‘ Ä‘Ă£ nháº­p thĂ¡ng nĂ y (náº¿u cĂ³)
app.get('/api/electricity/bulk-data', async (req, res) => {
  try {
    const { year, month } = req.query;
    if (!year || !month) return res.status(400).json({ error: 'Cáº§n cung cáº¥p year vĂ  month' });

    const y = parseInt(year);
    const m = parseInt(month);

    // ThĂ¡ng trÆ°á»›c Ä‘á»ƒ láº¥y chá»‰ sá»‘ cÅ©
    const prevM = m === 1 ? 12 : m - 1;
    const prevY = m === 1 ? y - 1 : y;

    // Láº¥y táº¥t cáº£ phĂ²ng (bao gá»“m billing_day Ä‘á»ƒ biáº¿t Ä‘á»£t thu tiá»n)
    const rooms = await db.prepare(
      "SELECT r.*, r.billing_day, (SELECT COUNT(*) FROM tenants t WHERE t.room_id = r.id) as tenant_count FROM rooms r ORDER BY r.zone ASC, r.room_code ASC"
    ).all();

    // Láº¥y chá»‰ sá»‘ Ä‘iá»‡n thĂ¡ng hiá»‡n táº¡i (náº¿u Ä‘Ă£ nháº­p)
    const currentReadings = await db.prepare(
      'SELECT * FROM electricity_readings WHERE year = ? AND month = ?'
    ).all(y, m);
    const currentMap = {};
    currentReadings.forEach(r => { currentMap[r.room_id] = r; });

    // Láº¥y chá»‰ sá»‘ cÅ© (new_reading cá»§a thĂ¡ng trÆ°á»›c) hoáº·c chá»‰ sá»‘ má»›i nháº¥t (SQLite compatible)
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

// LÆ°u hĂ ng loáº¡t chá»‰ sá»‘ Ä‘iá»‡n
app.post('/api/electricity/bulk', async (req, res) => {
  try {
    const { year, month, readings } = req.body;
    // readings: [{ room_id, old_reading, new_reading }]
    if (!year || !month || !Array.isArray(readings) || readings.length === 0)
      return res.status(400).json({ error: 'Dá»¯ liá»‡u khĂ´ng há»£p lá»‡' });

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

      // Sync vá»›i rent_payments náº¿u tá»“n táº¡i
      await db.prepare(`
        UPDATE rent_payments 
        SET electricity_amount = ?, total_amount = rent_amount + ? + water_amount + trash_amount + residence_amount + deposit_amount, updated_at = CURRENT_TIMESTAMP
        WHERE room_id = ? AND year = ? AND month = ?
      `).run(totalCost, totalCost, room_id, parseInt(year), parseInt(month));

      results.push({ room_id, consumption, totalCost });
    }

    res.json({
      message: `ÄĂ£ lÆ°u ${results.length} phĂ²ng thĂ nh cĂ´ng${errorCount > 0 ? `, bá» qua ${errorCount} phĂ²ng lá»—i` : ''}`,
      saved: results.length,
      errors: errorCount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 5. API THU TIá»€N THĂNG (RENT PAYMENTS) đŸ’°
// ==========================================

// Láº¥y danh sĂ¡ch thu tiá»n cá»§a thĂ¡ng/nÄƒm - bao gá»“m tiá»n thuĂª + tiá»n Ä‘iá»‡n tá»«ng phĂ²ng
app.get('/api/payments', async (req, res) => {
  try {
    const { year, month } = req.query;
    if (!year || !month) return res.status(400).json({ error: 'Cáº§n cung cáº¥p year vĂ  month' });

    // Láº¥y giĂ¡ nÆ°á»›c/rĂ¡c/táº¡m trĂº tá»« settings
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
          // Náº¿u thuĂª báº¯t Ä‘áº§u tá»« thĂ¡ng nĂ y hoáº·c tÆ°Æ¡ng lai, thĂ¬ khĂ´ng hiá»ƒn thá»‹ trong danh sĂ¡ch thu tiá»n thĂ¡ng nĂ y
          if (leaseYear > billingYear || (leaseYear === billingYear && leaseMonth >= billingMonth)) {
            return false;
          }
        }
      }
      return true;
    });

    // Gáº¯n waterAmount, trashAmount, residenceAmount, depositAmount, computedTotal cho má»—i dĂ²ng
    const enrichedRows = filteredRows.map(row => {
      const memberCount = row.member_count || 0;
      const isPaid = row.is_paid === 1;

      // XĂ¡c Ä‘á»‹nh thĂ¡ng báº¯t Ä‘áº§u há»£p Ä‘á»“ng (thĂ¡ng Ä‘Ă³ng tiá»n cá»c) vĂ  thĂ¡ng tĂ­nh tiá»n Ä‘áº§u tiĂªn (thĂ¡ng tiáº¿p theo)
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

      // Náº¿u chÆ°a thu tiá»n (isPaid = false), luĂ´n tĂ­nh láº¡i theo sá»‘ ngÆ°á»i á»Ÿ hiá»‡n táº¡i vĂ  Ä‘Æ¡n giĂ¡ cĂ i Ä‘áº·t má»›i
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

// ÄĂ¡nh dáº¥u Ä‘Ă£ thu / chÆ°a thu tiá»n
app.post('/api/payments/mark', async (req, res) => {
  try {
    const { room_id, year, month, is_paid, note } = req.body;
    if (!room_id || !year || !month)
      return res.status(400).json({ error: 'Thiáº¿u thĂ´ng tin báº¯t buá»™c' });

    const room = await db.prepare('SELECT rent_price, deposit, member_count, billing_day FROM rooms WHERE id = ?').get(room_id);
    if (!room) return res.status(404).json({ error: 'KhĂ´ng tĂ¬m tháº¥y phĂ²ng' });

    const elec = await db.prepare(
      'SELECT total_cost FROM electricity_readings WHERE room_id = ? AND year = ? AND month = ?'
    ).get(room_id, parseInt(year), parseInt(month));

    const tenants = await db.prepare('SELECT full_name FROM tenants WHERE room_id = ?').all(room_id);
    const tenantName = tenants.map(t => t.full_name).join(', ') || null;

    // Láº¥y giĂ¡ nÆ°á»›c/rĂ¡c/táº¡m trĂº tá»« settings
    const settingsList = await db.prepare('SELECT key, value FROM settings WHERE key IN (?, ?, ?)')
      .all('water_price', 'trash_price', 'residence_price');
    const settingsMap = {};
    settingsList.forEach(s => { settingsMap[s.key] = parseFloat(s.value) || 0; });
    const waterPrice = settingsMap['water_price'] || 20000;
    const trashPrice = settingsMap['trash_price'] || 10000;
    const residencePrice = settingsMap['residence_price'] || 50000;
    const memberCount = room.member_count || 0;

    // Kiá»ƒm tra thĂ¡ng Ä‘áº§u tiĂªn thu tiá»n
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

    res.json({ message: is_paid ? 'âœ… ÄĂ£ Ä‘Ă¡nh dáº¥u ÄĂƒ THU tiá»n' : 'â†©ï¸ ÄĂ£ bá» Ä‘Ă¡nh dáº¥u thu tiá»n', totalAmount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 6. API SETTINGS (CĂ€I Äáº¶T)
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

    res.json({ message: 'Cáº­p nháº­t cĂ i Ä‘áº·t thĂ nh cĂ´ng' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ==========================================
// 7. API Táº O HĂ“A ÄÆ N
// ==========================================
app.get('/api/invoice', async (req, res) => {
  try {
    const { room_id, year, month } = req.query;
    if (!room_id || !year || !month) {
      return res.status(400).json({ error: 'Thiáº¿u thĂ´ng tin phĂ²ng, thĂ¡ng hoáº·c nÄƒm' });
    }

    const room = await db.prepare('SELECT * FROM rooms WHERE id = ?').get(room_id);
    if (!room) return res.status(404).json({ error: 'KhĂ´ng tĂ¬m tháº¥y phĂ²ng' });

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

    // Kiá»ƒm tra xem cĂ³ pháº£i thĂ¡ng Ä‘áº§u tiĂªn hoáº·c thĂ¡ng báº¯t Ä‘áº§u thuĂª khĂ´ng
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

    // Láº¥y giĂ¡ nÆ°á»›c/rĂ¡c/táº¡m trĂº
    const waterPrice = parseFloat(settings['water_price']) || 20000;
    const trashPrice = parseFloat(settings['trash_price']) || 10000;
    const residencePrice = parseFloat(settings['residence_price']) || 50000;
    const memberCount = room.member_count || 0;

    const waterAmount = (isExcludedMonth || isDepositMonth) && (!payment || payment.is_paid !== 1) ? 0 : (payment ? (payment.water_amount || 0) : waterPrice * memberCount);
    const trashAmount = (isExcludedMonth || isDepositMonth) && (!payment || payment.is_paid !== 1) ? 0 : (payment ? (payment.trash_amount || 0) : trashPrice * memberCount);

    // Xá»­ lĂ½ tĂ¹y chá»n phĂ­ táº¡m trĂº
    const includeResidenceParam = req.query.include_residence; // 'force' | 'none' | 'auto' | undefined
    let residenceAmount;
    if ((isExcludedMonth || isDepositMonth) && (!payment || payment.is_paid !== 1)) {
      residenceAmount = 0;
    } else if (payment && payment.residence_amount !== null && payment.residence_amount !== undefined) {
      // ÄĂ£ thu tiá»n rá»“i: dĂ¹ng giĂ¡ trá»‹ thá»±c táº¿
      residenceAmount = payment.residence_amount;
    } else if (includeResidenceParam === 'force') {
      // Báº¯t buá»™c thĂªm phĂ­ táº¡m trĂº
      residenceAmount = residencePrice * memberCount;
    } else if (includeResidenceParam === 'none') {
      // KhĂ´ng tĂ­nh phĂ­ táº¡m trĂº
      residenceAmount = 0;
    } else {
      // Tá»± Ä‘á»™ng: chá»‰ tĂ­nh thĂ¡ng Ä‘áº§u tiĂªn
      residenceAmount = isFirstMonth ? residencePrice * memberCount : 0;
    }
    const depositAmount = isExcludedMonth && (!payment || payment.is_paid !== 1) ? 0 : (payment ? (payment.deposit_amount || 0) : (isDepositMonth ? (room.deposit || 0) : 0));
    const totalAmount = rentAmount + elecAmount + waterAmount + trashAmount + residenceAmount + depositAmount;

    // Láº¥y chá»‰ sá»‘ Ä‘iá»‡n má»›i nháº¥t cá»§a phĂ²ng
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
// 8. API TĂŒM KIáº¾M TOĂ€N Cá»¤C
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
// 9. Gá»¬I BĂO CĂO NHáº®C Ná»¢ QUA TELEGRAM đŸ“¨
// ==========================================
async function sendDailyTelegramNotification(force = false) {
  try {
    // 1. Láº¥y cĂ i Ä‘áº·t tá»« database settings
    const list = await db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    list.forEach(s => { settings[s.key] = s.value; });

    const enabled = settings['email_enabled'] === 'true';
    const botToken = settings['telegram_bot_token'];
    const adminChatId = settings['telegram_admin_chat_id'];

    if (!force) {
      if (!enabled || !botToken || !adminChatId) return;

      // Kiá»ƒm tra xem hĂ´m nay Ä‘Ă£ gá»­i chÆ°a (theo mĂºi giá» Viá»‡t Nam UTC+7)
      const nowVN = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
      const todayStr = `${nowVN.getFullYear()}-${nowVN.getMonth() + 1}-${nowVN.getDate()}`;

      if (settings['last_email_sent_date'] === todayStr) {
        return; // HĂ´m nay Ä‘Ă£ gá»­i rá»“i
      }

      // Chá»‰ gá»­i vĂ o lĂºc 8h sĂ¡ng
      const hour = nowVN.getHours();
      if (hour !== 8) {
        return;
      }
    } else {
      if (!botToken || !adminChatId) {
        throw new Error('Telegram Bot chÆ°a Ä‘Æ°á»£c cáº¥u hĂ¬nh. Vui lĂ²ng káº¿t ná»‘i Bot Telegram trÆ°á»›c.');
      }
    }

    const nowVN = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
    const todayStr = `${nowVN.getFullYear()}-${nowVN.getMonth() + 1}-${nowVN.getDate()}`;
    const todayDisplay = `${nowVN.getDate()}/${nowVN.getMonth() + 1}/${nowVN.getFullYear()}`;

    // 2. Láº¥y dá»¯ liá»‡u phĂ²ng trá» chÆ°a Ä‘Ă³ng tiá»n
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
          if (diffMonths === 1) isFirstMonth = true;
          else if (diffMonths === 0) isDepositMonth = true;
          else if (diffMonths < 0) isExcludedMonth = true;
        }
      }

      if (isDepositMonth || isExcludedMonth) continue;

      const rentAmt = row.rent_price || 0;
      const elecAmt = row.electricity_amount || 0;
      const memberCount = row.member_count || 0;
      const waterAmt = row.water_amount !== null && row.water_amount !== undefined ? row.water_amount : waterPrice * memberCount;
      const trashAmt = row.trash_amount !== null && row.trash_amount !== undefined ? row.trash_amount : trashPrice * memberCount;
      const residenceAmt = row.residence_amount !== null && row.residence_amount !== undefined ? row.residence_amount : (isFirstMonth ? residencePrice * memberCount : 0);
      const depositAmt = row.deposit_amount !== null && row.deposit_amount !== undefined ? row.deposit_amount : 0;
      const totalAmt = rentAmt + elecAmt + waterAmt + trashAmt + residenceAmt + depositAmt;

      let dueDay = row.billing_day || 30;
      const lastDay = new Date(currentYear, currentMonth, 0).getDate();
      const finalDay = Math.min(dueDay, lastDay);
      const dueDate = new Date(currentYear, currentMonth - 1, finalDay);
      const diffTime = dueDate - todayStart;
      const daysUntilDue = Math.round(diffTime / (1000 * 60 * 60 * 24));

      if (daysUntilDue <= 15) {
        dueRooms.push({
          room_code: row.room_code,
          tenant_name: row.tenant_names || 'ChÆ°a cĂ³ ngÆ°á»i thuĂª',
          total_amount: totalAmt,
          daysUntilDue,
          dueDateStr: `${finalDay}/${currentMonth}/${currentYear}`
        });
      }
    }

    if (dueRooms.length === 0 && !force) {
      console.log(`[Telegram] HĂ´m nay ${todayStr} khĂ´ng cĂ³ phĂ²ng nĂ o sáº¯p Ä‘áº¿n háº¡n/quĂ¡ háº¡n.`);
      return;
    }

    // 3. XĂ¢y dá»±ng tin nháº¯n Telegram
    let msg = `đŸ”” *BĂ¡o cĂ¡o nháº¯c ná»£ ngĂ y ${todayDisplay}*\n\n`;

    if (dueRooms.length > 0) {
      msg += `đŸ  CĂ³ *${dueRooms.length}* phĂ²ng chÆ°a Ä‘Ă³ng tiá»n sáº¯p Ä‘áº¿n háº¡n hoáº·c quĂ¡ háº¡n:\n\n`;
      for (const room of dueRooms) {
        let statusIcon = 'â³';
        let statusText = `CĂ²n ${room.daysUntilDue} ngĂ y`;
        if (room.daysUntilDue === 0) { statusIcon = 'đŸ¨'; statusText = 'Äáº¿n háº¡n hĂ´m nay'; }
        else if (room.daysUntilDue < 0) { statusIcon = 'â ï¸'; statusText = `QuĂ¡ háº¡n ${Math.abs(room.daysUntilDue)} ngĂ y`; }
        msg += `đŸ”‘ PhĂ²ng *${room.room_code}* â€” ${room.tenant_name}\n`;
        msg += `   đŸ’° ${room.total_amount.toLocaleString('vi-VN')}Ä‘ â€¢ Háº¡n: ${room.dueDateStr}\n`;
        msg += `   ${statusIcon} ${statusText}\n\n`;
      }
    } else {
      msg += `âœ… KhĂ´ng cĂ³ phĂ²ng nĂ o sáº¯p Ä‘áº¿n háº¡n hay quĂ¡ háº¡n trong hĂ´m nay.\n`;
    }

    msg += `\nâ€”â€”â€”â€”â€”â€”â€”â€”â€”â€”\n_Há»‡ thá»‘ng quáº£n lĂ½ nhĂ  trá» LISO gá»­i tá»± Ä‘á»™ng_`;

    await telegramBot.sendDirectMessage(adminChatId, msg, { parse_mode: 'Markdown' });

    // 4. Cáº­p nháº­t ngĂ y gá»­i thĂ nh cĂ´ng
    await db.prepare(
      "INSERT INTO settings (key, value) VALUES ('last_email_sent_date', ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP"
    ).run(todayStr);

    console.log(`[Telegram] ÄĂ£ gá»­i bĂ¡o cĂ¡o tá»± Ä‘á»™ng thĂ nh cĂ´ng ngĂ y ${todayStr}`);
  } catch (err) {
    console.error('[Telegram Error] Tháº¥t báº¡i khi gá»­i bĂ¡o cĂ¡o:', err);
    if (force) throw err;
  }
}

// ==========================================
// TELEGRAM BOT API
// ==========================================

// Láº¥y cáº¥u hĂ¬nh bot hiá»‡n táº¡i
app.get('/api/telegram/status', async (req, res) => {
  try {
    const tokenRow = await db.prepare("SELECT value FROM settings WHERE key = 'telegram_bot_token'").get();
    const chatIdRow = await db.prepare("SELECT value FROM settings WHERE key = 'telegram_admin_chat_id'").get();
    const status = telegramBot.getBotStatus();
    res.json({
      hasToken: !!(tokenRow && tokenRow.value),
      hasChatId: !!(chatIdRow && chatIdRow.value),
      running: status.running,
      // MĂ  hoĂ¡ token Ä‘á»ƒ hiá»ƒn thá»‹ an toĂ n (chá»‰ hiá»‡n 10 kĂ½ tá»± Ä‘áº§u)
      tokenPreview: tokenRow?.value ? tokenRow.value.substring(0, 12) + '...' : null,
      adminChatId: chatIdRow?.value || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LÆ°u cáº¥u hĂ¬nh vĂ  khá»Ÿi Ä‘á»™ng bot
app.post('/api/telegram/connect', async (req, res) => {
  try {
    const { token, adminChatId } = req.body;
    if (!token || !adminChatId) {
      return res.status(400).json({ error: 'Cáº§n cĂ³ Bot Token vĂ  Admin Chat ID' });
    }

    // LÆ°u vĂ o settings
    await db.prepare("INSERT INTO settings (key, value) VALUES ('telegram_bot_token', ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP").run(token.trim());
    await db.prepare("INSERT INTO settings (key, value) VALUES ('telegram_admin_chat_id', ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP").run(String(adminChatId).trim());

    // Khá»Ÿi Ä‘á»™ng bot
    const result = await telegramBot.startBot(token.trim(), String(adminChatId).trim(), db);
    if (result.ok) {
      res.json({ message: `âœ… Bot @${result.botName} Ä‘Ă£ káº¿t ná»‘i thĂ nh cĂ´ng!`, botName: result.botName });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ngáº¯t káº¿t ná»‘i bot
app.post('/api/telegram/disconnect', async (req, res) => {
  try {
    await telegramBot.stopBot();
    res.json({ message: 'đŸ”´ Bot Ä‘Ă£ ngáº¯t káº¿t ná»‘i' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint gá»­i thá»­ bĂ¡o cĂ¡o qua Telegram
app.post('/api/settings/test-report', async (req, res) => {
  try {
    await sendDailyTelegramNotification(true);
    res.json({ message: 'âœ… ÄĂ£ gá»­i bĂ¡o cĂ¡o thá»­ qua Telegram thĂ nh cĂ´ng! Vui lĂ²ng kiá»ƒm tra Telegram cá»§a báº¡n.' });
  } catch (err) {
    res.status(500).json({ error: `Gá»­i bĂ¡o cĂ¡o Telegram tháº¥t báº¡i: ${err.message}` });
  }
});

// Láº­p trĂ¬nh kiá»ƒm tra gá»­i Telegram tá»± Ä‘á»™ng (Cá»© má»—i 15 phĂºt cháº¡y 1 láº§n Ä‘á»ƒ check lĂºc 8h sĂ¡ng)
setTimeout(() => {
  sendDailyTelegramNotification().catch(console.error);
}, 10000); // Cháº¡y thá»­ láº§n Ä‘áº§u 10 giĂ¢y sau khi khá»Ÿi Ä‘á»™ng

setInterval(() => {
  sendDailyTelegramNotification().catch(console.error);
}, 15 * 60 * 1000); // Kiá»ƒm tra láº¡i sau má»—i 15 phĂºt

app.listen(PORT, async () => {
  console.log(`âœ… Server Ä‘ang cháº¡y táº¡i http://localhost:${PORT}`);

  // Tá»± Ä‘á»™ng khá»Ÿi Ä‘á»™ng Telegram Bot náº¿u Ä‘Ă£ cĂ³ token trong cĂ i Ä‘áº·t
  try {
    const tokenRow = await db.prepare("SELECT value FROM settings WHERE key = 'telegram_bot_token'").get();
    const chatIdRow = await db.prepare("SELECT value FROM settings WHERE key = 'telegram_admin_chat_id'").get();
    if (tokenRow?.value && chatIdRow?.value) {
      const result = await telegramBot.startBot(tokenRow.value, chatIdRow.value, db);
      if (result.ok) {
        console.log(`âœ… Telegram Bot @${result.botName} Ä‘Ă£ tá»± Ä‘á»™ng káº¿t ná»‘i!`);
      } else {
        console.warn(`â ï¸ KhĂ´ng thá»ƒ káº¿t ná»‘i Telegram Bot: ${result.error}`);
      }
    }
  } catch (e) {
    console.warn('â ï¸ Telegram Bot khĂ´ng khá»Ÿi Ä‘á»™ng Ä‘Æ°á»£c:', e.message);
  }
});

