const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_dnlszBw4T2HV@ep-jolly-mode-atgnmc0h-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require';

const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

// Hàm khởi tạo cơ sở dữ liệu
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Tạo các bảng
    await client.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id SERIAL PRIMARY KEY,
        room_code TEXT UNIQUE NOT NULL,
        zone TEXT NOT NULL, -- 'A' hoặc 'B'
        rent_price REAL DEFAULT 0,
        deposit REAL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'vacant', -- 'vacant', 'occupied', 'maintenance'
        member_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id SERIAL PRIMARY KEY,
        room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        full_name TEXT NOT NULL,
        phone TEXT,
        cccd TEXT,
        start_date DATE NOT NULL,
        end_date DATE,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS electricity_readings (
        id SERIAL PRIMARY KEY,
        room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL,
        old_reading REAL NOT NULL DEFAULT 0,
        new_reading REAL NOT NULL DEFAULT 0,
        consumption REAL NOT NULL DEFAULT 0,
        unit_price REAL NOT NULL,
        total_cost REAL NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(room_id, year, month)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rent_payments (
        id SERIAL PRIMARY KEY,
        room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL,
        rent_amount REAL NOT NULL DEFAULT 0,
        electricity_amount REAL NOT NULL DEFAULT 0,
        water_amount REAL NOT NULL DEFAULT 0,
        trash_amount REAL NOT NULL DEFAULT 0,
        total_amount REAL NOT NULL DEFAULT 0,
        is_paid INTEGER NOT NULL DEFAULT 0,  -- 0 = chưa thu, 1 = đã thu
        paid_at TIMESTAMP,
        note TEXT,
        tenant_name TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(room_id, year, month)
      );
    `);

    // Migration: thêm cột water_amount và trash_amount nếu chưa có (cho DB cũ)
    try {
      await client.query(`ALTER TABLE rent_payments ADD COLUMN IF NOT EXISTS water_amount REAL NOT NULL DEFAULT 0`);
      await client.query(`ALTER TABLE rent_payments ADD COLUMN IF NOT EXISTS trash_amount REAL NOT NULL DEFAULT 0`);
    } catch(e) { /* columns already exist */ }

    await client.query('COMMIT');
    console.log('✅ Đã tạo các bảng dữ liệu trên Postgres thành công.');

    // Seed data nếu chưa có phòng hoặc chưa có người thuê (reset danh sách phòng chuẩn)
    const resRooms = await client.query('SELECT COUNT(*) as count FROM rooms');
    const roomCount = parseInt(resRooms.rows[0].count, 10);
    const resTenants = await client.query('SELECT COUNT(*) as count FROM tenants');
    const tenantCount = parseInt(resTenants.rows[0].count, 10);

    if (roomCount === 0 || tenantCount === 0) {
      console.log('Đang khởi tạo/cập nhật lại danh sách phòng chuẩn mới...');
      
      // Xóa sạch phòng cũ nếu chưa có người thuê để nạp lại danh sách mới
      await client.query('TRUNCATE TABLE rooms RESTART IDENTITY CASCADE');
      
      // 1. Khu A:
      // Tầng 1: A101 - A114 (14 phòng)
      for (let i = 1; i <= 14; i++) {
        const num = i < 10 ? `0${i}` : `${i}`;
        await client.query(
          `INSERT INTO rooms (room_code, zone, rent_price, deposit, status, member_count) VALUES ($1, $2, $3, $4, $5, $6)`,
          [`A1${num}`, 'A', 0, 0, 'vacant', 0]
        );
      }

      // Tầng 2: A201 - A208 (8 phòng)
      for (let i = 1; i <= 8; i++) {
        const num = i < 10 ? `0${i}` : `${i}`;
        await client.query(
          `INSERT INTO rooms (room_code, zone, rent_price, deposit, status, member_count) VALUES ($1, $2, $3, $4, $5, $6)`,
          [`A2${num}`, 'A', 0, 0, 'vacant', 0]
        );
      }

      // Tầng 3: A301 - A308 (8 phòng)
      for (let i = 1; i <= 8; i++) {
        const num = i < 10 ? `0${i}` : `${i}`;
        await client.query(
          `INSERT INTO rooms (room_code, zone, rent_price, deposit, status, member_count) VALUES ($1, $2, $3, $4, $5, $6)`,
          [`A3${num}`, 'A', 0, 0, 'vacant', 0]
        );
      }

      // Tầng 4: A401 - A406 (6 phòng)
      for (let i = 1; i <= 6; i++) {
        const num = i < 10 ? `0${i}` : `${i}`;
        await client.query(
          `INSERT INTO rooms (room_code, zone, rent_price, deposit, status, member_count) VALUES ($1, $2, $3, $4, $5, $6)`,
          [`A4${num}`, 'A', 0, 0, 'vacant', 0]
        );
      }

      // 2. Khu B: 15 phòng (B01 - B15)
      for (let i = 1; i <= 15; i++) {
        const num = i < 10 ? `0${i}` : `${i}`;
        await client.query(
          `INSERT INTO rooms (room_code, zone, rent_price, deposit, status, member_count) VALUES ($1, $2, $3, $4, $5, $6)`,
          [`B${num}`, 'B', 0, 0, 'vacant', 0]
        );
      }
      console.log('✅ Khởi tạo thành công danh sách phòng chuẩn mới.');
    }

    // Seed cài đặt mặc định nếu chưa có
    const insertSetting = async (key, defaultValue) => {
      const res = await client.query('SELECT COUNT(*) FROM settings WHERE key = $1', [key]);
      if (parseInt(res.rows[0].count, 10) === 0) {
        await client.query('INSERT INTO settings (key, value) VALUES ($1, $2)', [key, defaultValue]);
        console.log(`Đã khởi tạo cài đặt: ${key} = ${defaultValue}`);
      }
    };
    
    await insertSetting('electricity_price', '3500');
    await insertSetting('water_price', '20000');    // VNĐ/người/tháng
    await insertSetting('trash_price', '10000');    // VNĐ/người/tháng
    await insertSetting('bank_name', 'MBBank');
    await insertSetting('bank_account', '099999999999');
    await insertSetting('bank_owner', 'NGUYEN VAN A');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Lỗi khởi tạo database Postgres:', err);
  } finally {
    client.release();
  }
}

// Khởi chạy đồng bộ database
initDatabase().catch(err => console.error(err));

// Wrapper mô phỏng API đồng bộ của better-sqlite3 bằng hàm bất đồng bộ
class PostgresStatement {
  constructor(sql) {
    // Chuyển ? của SQLite sang $1, $2 của Postgres
    let index = 1;
    let newSql = sql.replace(/\?/g, () => `$${index++}`);
    
    // Một số từ khóa đặc trưng của SQLite sang Postgres
    newSql = newSql.replace(/\bGROUP_CONCAT\(([^,]+),\s*([^)]+)\)/gi, 'STRING_AGG($1, $2)');
    newSql = newSql.replace(/\bMAX\b/gi, 'GREATEST');
    this.sql = newSql;
  }

  // Parse chuỗi số tự động từ Postgres sang kiểu số trong JS
  parseRow(row) {
    if (!row) return null;
    for (const key in row) {
      if (typeof row[key] === 'string' && /^\d+$/.test(row[key])) {
        const val = parseInt(row[key], 10);
        if (!isNaN(val)) row[key] = val;
      } else if (typeof row[key] === 'string' && /^\d+\.\d+$/.test(row[key])) {
        const val = parseFloat(row[key]);
        if (!isNaN(val)) row[key] = val;
      }
    }
    return row;
  }

  async get(...params) {
    const res = await pool.query(this.sql, params);
    return this.parseRow(res.rows[0]) || null;
  }

  async all(...params) {
    const res = await pool.query(this.sql, params);
    return res.rows.map(row => this.parseRow(row));
  }

  async run(...params) {
    const res = await pool.query(this.sql, params);
    return {
      changes: res.rowCount,
      lastInsertRowid: res.rows[0] ? res.rows[0].id : null
    };
  }
}

module.exports = {
  prepare: (sql) => new PostgresStatement(sql),
  pool
};
