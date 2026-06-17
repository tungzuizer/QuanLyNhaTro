const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Đảm bảo thư mục data tồn tại
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'nha-tro.db');
const db = new Database(dbPath);

// Tối ưu hóa hiệu năng SQLite
db.pragma('journal_mode = WAL');

// Tạo các bảng
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT UNIQUE NOT NULL,
    zone TEXT NOT NULL, -- 'A' hoặc 'B'
    rent_price REAL DEFAULT 0,
    deposit REAL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'vacant', -- 'vacant' (trống), 'occupied' (đang thuê), 'maintenance' (sửa chữa)
    member_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    full_name TEXT NOT NULL,
    phone TEXT,
    cccd TEXT,
    start_date DATE NOT NULL,
    end_date DATE,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS electricity_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    old_reading REAL NOT NULL DEFAULT 0,
    new_reading REAL NOT NULL DEFAULT 0,
    consumption REAL NOT NULL DEFAULT 0,
    unit_price REAL NOT NULL,
    total_cost REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    UNIQUE(room_id, year, month)
  );

  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rent_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    rent_amount REAL NOT NULL DEFAULT 0,
    electricity_amount REAL NOT NULL DEFAULT 0,
    total_amount REAL NOT NULL DEFAULT 0,
    is_paid INTEGER NOT NULL DEFAULT 0,  -- 0 = chưa thu, 1 = đã thu
    paid_at DATETIME,
    note TEXT,
    tenant_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    UNIQUE(room_id, year, month)
  );
`);

// Migration: Thêm cột tenant_name vào bảng rent_payments nếu chưa có
try {
  db.exec("ALTER TABLE rent_payments ADD COLUMN tenant_name TEXT");
  console.log('✅ Đã cập nhật database: Thêm cột tenant_name vào bảng rent_payments');
} catch (err) {
  // Cột đã tồn tại, bỏ qua lỗi
}


// Seed data nếu bảng rooms trống
const roomCount = db.prepare('SELECT COUNT(*) as count FROM rooms').get();
if (roomCount.count === 0) {
  console.log('Chưa có dữ liệu phòng, đang tự động khởi tạo 50 phòng...');

  const insertRoom = db.prepare(`
    INSERT INTO rooms (room_code, zone, rent_price, deposit, status, member_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    // Khu A: 35 phòng (A01 - A35)
    for (let i = 1; i <= 35; i++) {
      const num = i < 10 ? `0${i}` : `${i}`;
      insertRoom.run(`A${num}`, 'A', 0, 0, 'vacant', 0);
    }

    // Khu B: 15 phòng (B01 - B15)
    for (let i = 1; i <= 15; i++) {
      const num = i < 10 ? `0${i}` : `${i}`;
      insertRoom.run(`B${num}`, 'B', 0, 0, 'vacant', 0);
    }
  });

  transaction();
  console.log('Đã tạo thành công 50 phòng (35 phòng Khu A, 15 phòng Khu B).');
}

// Seed cài đặt mặc định nếu trống
const settingsCount = db.prepare('SELECT COUNT(*) as count FROM settings').get();
if (settingsCount.count === 0) {
  const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  insertSetting.run('electricity_price', '3500'); // Giá mặc định 3500 đ/kWh
  console.log('Đã khởi tạo giá điện mặc định: 3,500 đ/kWh');
}

module.exports = db;
