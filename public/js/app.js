// API Base URL (Dùng relative path vì chạy cùng server)
const API_BASE = '';

// Khởi tạo State toàn cục
let currentState = {
  currentTab: 'dashboard',
  rooms: [],
  selectedRoomId: null,
  selectedRoomData: null,
  electricityPrice: 3500
};

// Khởi chạy khi DOM load xong
document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

// ==========================================
// KHỞI TẠO ỨNG DỤNG
// ==========================================
function initApp() {
  // 1. Quản lý Router / Tabs
  initTabs();

  // 2. Load Dữ liệu ban đầu
  loadSettings();
  loadDashboardData();

  // 3. Đăng ký các Event Listeners
  registerEventListeners();

  // 4. Khởi tạo dropdown tháng/năm ở Tab điện năng
  initElectricDateDropdowns();

  // Khôi phục Tab đã chọn từ localStorage
  const savedTab = localStorage.getItem('currentTab') || 'dashboard';
  switchTab(savedTab);

  // Khôi phục giá trị tìm kiếm
  const savedSearch = localStorage.getItem('searchQuery');
  if (savedSearch) {
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.value = savedSearch;
      if (savedTab === 'search') {
        triggerGlobalSearch();
      }
    }
  }

  // Khôi phục phòng đang chọn trong tab điện
  const savedElecRoom = localStorage.getItem('selectedElecRoomId');
  if (savedElecRoom) {
    setTimeout(() => {
      const select = document.getElementById('elec-room-select');
      if (select) {
        select.value = savedElecRoom;
        select.dispatchEvent(new Event('change'));
      }
    }, 200);
  }
}

// ==========================================
// TABS & ROUTING LOGIC
// ==========================================
function initTabs() {
  const navItems = document.querySelectorAll('.nav-item');
  
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const tabId = item.getAttribute('data-tab');
      switchTab(tabId);
    });
  });

  // Hỗ trợ click vào ô tìm kiếm nhanh chuyển sang Tab Tìm Kiếm
  const quickSearch = document.getElementById('quick-search-input');
  if (quickSearch) {
    quickSearch.addEventListener('click', () => {
      switchTab('search');
      setTimeout(() => {
        document.getElementById('search-input').focus();
      }, 100);
    });
  }
}

function switchTab(tabId) {
  currentState.currentTab = tabId;
  localStorage.setItem('currentTab', tabId);

  // Cập nhật Active class trên Sidebar
  document.querySelectorAll('.nav-item').forEach(item => {
    if (item.getAttribute('data-tab') === tabId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Cập nhật Page Title
  const titles = {
    dashboard: 'Dashboard',
    rooms: 'Quản Lý Phòng',
    electricity: 'Quản Lý Điện',
    payments: 'Thu Tiền Tháng',
    search: 'Tìm Kiếm Dữ Liệu',
    settings: 'Cài Đặt Hệ Thống'
  };
  document.getElementById('page-title').textContent = titles[tabId] || 'Nhà Trọ Home';

  // Hiển thị Tab Pane tương ứng
  document.querySelectorAll('.tab-pane').forEach(pane => {
    if (pane.id === `tab-${tabId}`) {
      pane.classList.add('active');
    } else {
      pane.classList.remove('active');
    }
  });

  // Load lại dữ liệu đặc thù của từng tab
  if (tabId === 'dashboard') {
    loadDashboardData();
  } else if (tabId === 'rooms') {
    loadRoomsData();
  } else if (tabId === 'electricity') {
    loadRoomsDropdown();
  } else if (tabId === 'payments') {
    initPaymentsTab();
  }
}

// ==========================================
// EVENT LISTENERS REGISTER
// ==========================================
function registerEventListeners() {
  // --- FORM CẬP NHẬT PHÒNG ---
  const editRoomForm = document.getElementById('edit-room-form');
  editRoomForm.addEventListener('submit', handleRoomUpdateSubmit);

  const btnEditRoomTrigger = document.getElementById('btn-edit-room-trigger');
  const btnCancelEditRoom = document.getElementById('btn-cancel-edit-room');
  
  btnEditRoomTrigger.addEventListener('click', () => {
    if (currentState.selectedRoomData) {
      const room = currentState.selectedRoomData.room;
      document.getElementById('edit-rent-price').value = room.rent_price;
      document.getElementById('edit-deposit').value = room.deposit;
      document.getElementById('edit-status').value = room.status;
      editRoomForm.style.display = 'block';
      btnEditRoomTrigger.style.display = 'none';
    }
  });

  btnCancelEditRoom.addEventListener('click', () => {
    editRoomForm.style.display = 'none';
    btnEditRoomTrigger.style.display = 'block';
  });

  // --- FORM THÊM/SỬA NGƯỜI THUÊ ---
  const tenantForm = document.getElementById('tenant-form');
  tenantForm.addEventListener('submit', handleTenantSubmit);

  const btnAddTenantTrigger = document.getElementById('btn-add-tenant-trigger');
  const btnCancelTenant = document.getElementById('btn-cancel-tenant');

  btnAddTenantTrigger.addEventListener('click', () => {
    // Reset form tenant sang trạng thái Thêm Mới
    document.getElementById('tenant-id').value = '';
    document.getElementById('tenant-name').value = '';
    document.getElementById('tenant-phone').value = '';
    document.getElementById('tenant-cccd').value = '';
    document.getElementById('tenant-notes').value = '';
    
    // Set ngày bắt đầu là hôm nay
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('tenant-start-date').value = today;
    document.getElementById('tenant-end-date').value = '';

    document.getElementById('tenant-form-title').textContent = 'Thêm người thuê mới';
    tenantForm.style.display = 'block';
  });

  btnCancelTenant.addEventListener('click', () => {
    tenantForm.style.display = 'none';
  });

  // --- TAB ĐIỆN NĂNG EVENTS ---
  const elecRoomSelect = document.getElementById('elec-room-select');
  elecRoomSelect.addEventListener('change', () => {
    const roomId = elecRoomSelect.value;
    localStorage.setItem('selectedElecRoomId', roomId);
    if (roomId) {
      loadElectricityReadingForRoom(roomId);
    } else {
      document.getElementById('electric-history-table-body').innerHTML = `
        <tr><td colspan="6" class="text-center text-muted">Vui lòng chọn phòng để xem lịch sử</td></tr>
      `;
      document.getElementById('elec-calc-summary').style.display = 'none';
    }
  });

  // Sự kiện nhập số điện cũ/mới tự động tính toán
  const elecOld = document.getElementById('elec-old');
  const elecNew = document.getElementById('elec-new');
  [elecOld, elecNew].forEach(input => {
    input.addEventListener('input', calculateLiveElectricity);
  });

  const electricForm = document.getElementById('electric-form');
  electricForm.addEventListener('submit', handleElectricitySubmit);

  // --- TAB CÀI ĐẶT ---
  const settingsForm = document.getElementById('settings-form');
  settingsForm.addEventListener('submit', handleSettingsSubmit);

  // --- TÌM KIẾM ---
  const btnSearchTrigger = document.getElementById('btn-search-trigger');
  const searchInput = document.getElementById('search-input');
  
  btnSearchTrigger.addEventListener('click', triggerGlobalSearch);
  searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      triggerGlobalSearch();
    }
  });

  // --- ZONE FILTER TABS ---
  const zoneBtns = document.querySelectorAll('.zone-tab-btn');
  zoneBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      zoneBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadRoomsData();
    });
  });

  const statusFilter = document.getElementById('status-filter');
  statusFilter.addEventListener('change', loadRoomsData);

  // --- TAB THU TIỀN EVENTS ---
  document.getElementById('btn-load-payments').addEventListener('click', loadPaymentsData);

  // Filter buttons (Tất cả / Chưa thu / Đã thu)
  document.querySelectorAll('.pay-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pay-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filterPaymentRows(btn.getAttribute('data-filter'));
    });
  });
}

// ==========================================
// API HELPERS
// ==========================================
async function fetchAPI(endpoint, options = {}) {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      ...options
    });
    
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Lỗi hệ thống (${res.status})`);
    }
    return data;
  } catch (err) {
    showToast(err.message, 'error');
    throw err;
  }
}

// ==========================================
// TOAST NOTIFICATIONS SYSTEM
// ==========================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '❌';

  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
  container.appendChild(toast);

  // Tự hủy sau 3 giây
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3000);
}

// Custom Confirmation Modal sử dụng Promise
function showConfirm(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    const msgEl = document.getElementById('confirm-modal-message');
    const btnYes = document.getElementById('btn-confirm-yes');
    const btnNo = document.getElementById('btn-confirm-no');

    msgEl.textContent = message;
    modal.classList.add('active');

    const cleanUp = (result) => {
      modal.classList.remove('active');
      // Clone để xóa bỏ event listeners cũ tránh lặp sự kiện
      btnYes.replaceWith(btnYes.cloneNode(true));
      btnNo.replaceWith(btnNo.cloneNode(true));
      resolve(result);
    };

    document.getElementById('btn-confirm-yes').addEventListener('click', () => cleanUp(true));
    document.getElementById('btn-confirm-no').addEventListener('click', () => cleanUp(false));
  });
}

// Định dạng tiền tệ VND
function formatVND(amount) {
  if (amount === undefined || amount === null) return '0đ';
  return amount.toLocaleString('vi-VN') + 'đ';
}

// ==========================================
// 1. DASHBOARD BINDING
// ==========================================
async function loadDashboardData() {
  try {
    const data = await fetchAPI('/api/dashboard');
    document.getElementById('stat-total-rooms').textContent = data.totalRooms;
    document.getElementById('stat-vacant-rooms').textContent = data.vacantRooms;
    document.getElementById('stat-occupied-rooms').textContent = data.occupiedRooms;
    document.getElementById('stat-maintenance-rooms').textContent = data.maintenanceRooms;
    
    document.getElementById('stat-total-rent').textContent = formatVND(data.totalRentCost);
    document.getElementById('stat-total-electric').textContent = formatVND(data.totalElectricityCost);
    
    if (data.electricityMonth) {
      document.getElementById('stat-electric-month-label').textContent = `Dữ liệu tháng ${data.electricityMonth}/${data.electricityYear}`;
    }

    // Hiển thị thống kê thu tiền
    if (data.paymentStats && data.paymentStats.total > 0) {
      document.getElementById('stat-collected').textContent = formatVND(data.paymentStats.collected);
      document.getElementById('stat-paid-count').textContent = `${data.paymentStats.paidCount} phòng đã đóng`;
      document.getElementById('stat-pending').textContent = formatVND(data.paymentStats.pending);
      document.getElementById('stat-unpaid-count').textContent = `${data.paymentStats.unpaidCount} phòng chưa đóng`;
    }
  } catch (err) {
    console.error('Không thể load dashboard', err);
  }
}

// ==========================================
// 2. SETTINGS BINDING
// ==========================================
async function loadSettings() {
  try {
    const settings = await fetchAPI('/api/settings');
    if (settings.electricity_price) {
      currentState.electricityPrice = parseFloat(settings.electricity_price);
      const input = document.getElementById('setting-electric-price');
      if (input) input.value = currentState.electricityPrice;
    }
  } catch (err) {
    console.error('Không thể load settings', err);
  }
}

async function handleSettingsSubmit(e) {
  e.preventDefault();
  const price = document.getElementById('setting-electric-price').value;
  
  try {
    await fetchAPI('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ electricity_price: price })
    });
    currentState.electricityPrice = parseFloat(price);
    showToast('Đã lưu cấu hình giá điện mới', 'success');
  } catch (err) {
    console.error(err);
  }
}

// ==========================================
// 3. QUẢN LÝ PHÒNG (ROOMS TAB)
// ==========================================
async function loadRoomsData() {
  const activeZoneBtn = document.querySelector('.zone-tab-btn.active');
  const zone = activeZoneBtn.getAttribute('data-zone');
  const status = document.getElementById('status-filter').value;

  let url = '/api/rooms';
  const params = [];
  if (zone !== 'ALL') params.push(`zone=${zone}`);
  if (status !== 'ALL') params.push(`status=${status}`);
  
  if (params.length > 0) {
    url += '?' + params.join('&');
  }

  try {
    const rooms = await fetchAPI(url);
    currentState.rooms = rooms;
    renderRoomsGrid(rooms);
  } catch (err) {
    console.error(err);
  }
}

function renderRoomsGrid(rooms) {
  const grid = document.getElementById('rooms-grid');
  grid.innerHTML = '';

  if (rooms.length === 0) {
    grid.innerHTML = '<div class="text-center text-muted" style="grid-column: 1/-1; padding: 40px;">Không tìm thấy phòng nào phù hợp</div>';
    return;
  }

  rooms.forEach(room => {
    const card = document.createElement('div');
    card.className = `room-card status-${room.status}`;
    
    let statusText = 'Trống';
    if (room.status === 'occupied') statusText = 'Đang thuê';
    if (room.status === 'maintenance') statusText = 'Sửa chữa';

    const priceLabel = room.rent_price > 0 ? formatVND(room.rent_price) : 'Chưa đặt giá';

    card.innerHTML = `
      <div class="room-code">${room.room_code}</div>
      <div class="room-status">${statusText}</div>
      <div class="room-price">${priceLabel}</div>
      <div class="room-members">${room.member_count > 0 ? `👥 ${room.member_count} người` : 'Trống'}</div>
    `;

    card.addEventListener('click', () => openRoomDetailModal(room.id));
    grid.appendChild(card);
  });
}

// ==========================================
// 4. MODAL CHI TIẾT PHÒNG
// ==========================================
async function openRoomDetailModal(roomId) {
  currentState.selectedRoomId = roomId;
  
  // Reset form hiển thị
  document.getElementById('edit-room-form').style.display = 'none';
  document.getElementById('btn-edit-room-trigger').style.display = 'block';
  document.getElementById('tenant-form').style.display = 'none';

  await refreshRoomModalData();
  
  document.getElementById('room-detail-modal').classList.add('active');
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('active');
  // Load lại dữ liệu bên ngoài khi đóng modal để cập nhật trạng thái lưới phòng
  if (currentState.currentTab === 'rooms') {
    loadRoomsData();
  } else if (currentState.currentTab === 'dashboard') {
    loadDashboardData();
  } else if (currentState.currentTab === 'search') {
    triggerGlobalSearch();
  }
}

async function refreshRoomModalData() {
  if (!currentState.selectedRoomId) return;

  try {
    const data = await fetchAPI(`/api/rooms/${currentState.selectedRoomId}`);
    currentState.selectedRoomData = data;
    
    const room = data.room;
    
    // Bind thông tin phòng
    document.getElementById('modal-room-title').textContent = `Phòng ${room.room_code}`;
    document.getElementById('modal-room-zone').textContent = `Khu ${room.zone}`;
    
    const statusBadge = document.getElementById('modal-room-status-badge');
    statusBadge.className = 'badge';
    if (room.status === 'vacant') {
      statusBadge.textContent = 'Trống';
      statusBadge.classList.add('badge-vacant');
    } else if (room.status === 'occupied') {
      statusBadge.textContent = 'Đang thuê';
      statusBadge.classList.add('badge-occupied');
    } else {
      statusBadge.textContent = 'Đang sửa chữa';
      statusBadge.classList.add('badge-maintenance');
    }

    document.getElementById('modal-room-price').textContent = formatVND(room.rent_price);
    document.getElementById('modal-room-deposit').textContent = formatVND(room.deposit);
    document.getElementById('modal-room-members').textContent = `${room.member_count} người`;

    // Render danh sách người thuê
    renderTenantsList(data.tenants);

    // Render lịch sử đóng tiền & điện nước
    renderRoomPaymentHistory(data.paymentHistory);

  } catch (err) {
    console.error(err);
  }
}

function renderRoomPaymentHistory(paymentHistory) {
  const container = document.getElementById('modal-payment-history-list');
  container.innerHTML = '';

  if (!paymentHistory || paymentHistory.length === 0) {
    container.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Chưa có lịch sử hóa đơn cho phòng này</td></tr>';
    return;
  }

  paymentHistory.forEach(p => {
    const tr = document.createElement('tr');
    const isPaid = p.is_paid === 1;
    tr.innerHTML = `
      <td><strong>Tháng ${p.month}/${p.year}</strong></td>
      <td>${p.tenant_name || '<span class="text-muted">Không rõ</span>'}</td>
      <td>${formatVND(p.rent_amount)}</td>
      <td>${formatVND(p.electricity_amount)}</td>
      <td><strong>${formatVND(p.total_amount)}</strong></td>
      <td>
        <span class="pay-status-badge ${isPaid ? 'paid' : 'unpaid'}">
          ${isPaid ? '✅ Đã đóng' : '⏳ Chưa đóng'}
        </span>
      </td>
    `;
    container.appendChild(tr);
  });
}

function renderTenantsList(tenants) {
  const container = document.getElementById('modal-tenants-list');
  container.innerHTML = '';

  if (tenants.length === 0) {
    container.innerHTML = '<p class="text-muted text-center" style="padding: 20px;">Không có ai đang thuê phòng này</p>';
    return;
  }

  tenants.forEach(tenant => {
    const card = document.createElement('div');
    card.className = 'tenant-item';

    const startDateStr = tenant.start_date ? formatDate(tenant.start_date) : '--';
    const endDateStr = tenant.end_date ? formatDate(tenant.end_date) : 'Dài hạn';

    card.innerHTML = `
      <div class="tenant-main-info">
        <h4 class="tenant-name-heading"></h4>
        <div class="tenant-meta">
          <span>📞 SĐT: <strong class="tenant-phone-label"></strong></span>
          <span>🪪 CCCD: <strong class="tenant-cccd-label"></strong></span>
          <span>📅 HĐ: ${startDateStr} ➔ ${endDateStr}</span>
        </div>
        <div class="tenant-notes-label" style="display: none; margin-top: 5px;"></div>
      </div>
      <div class="tenant-actions">
        <button class="btn btn-sm btn-outline-secondary btn-edit">Sửa</button>
        <button class="btn btn-sm btn-danger btn-delete">Xóa</button>
      </div>
    `;

    card.querySelector('.tenant-name-heading').textContent = tenant.full_name;
    card.querySelector('.tenant-phone-label').textContent = tenant.phone || 'Chưa nhập';
    card.querySelector('.tenant-cccd-label').textContent = tenant.cccd || 'Chưa nhập';
    
    if (tenant.notes) {
      const notesEl = card.querySelector('.tenant-notes-label');
      notesEl.textContent = `📝 ${tenant.notes}`;
      notesEl.style.display = 'block';
    }

    card.querySelector('.btn-edit').addEventListener('click', () => {
      window.editTenant(tenant);
    });

    card.querySelector('.btn-delete').addEventListener('click', () => {
      window.deleteTenant(tenant.id);
    });

    container.appendChild(card);
  });
}

function formatDate(dateString) {
  const d = new Date(dateString);
  if (isNaN(d.getTime())) return dateString;
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

// --- CẬP NHẬT PHÒNG SUBMIT ---
async function handleRoomUpdateSubmit(e) {
  e.preventDefault();
  const price = document.getElementById('edit-rent-price').value;
  const deposit = document.getElementById('edit-deposit').value;
  const status = document.getElementById('edit-status').value;

  try {
    await fetchAPI(`/api/rooms/${currentState.selectedRoomId}`, {
      method: 'PUT',
      body: JSON.stringify({
        rent_price: parseFloat(price),
        deposit: parseFloat(deposit),
        status: status
      })
    });
    
    showToast('Cập nhật thông tin phòng thành công', 'success');
    document.getElementById('edit-room-form').style.display = 'none';
    document.getElementById('btn-edit-room-trigger').style.display = 'block';
    
    // Refresh dữ liệu
    refreshRoomModalData();
  } catch (err) {
    console.error(err);
  }
}

// --- NGƯỜI THUÊ SUBMIT ---
async function handleTenantSubmit(e) {
  e.preventDefault();
  
  const tenantId = document.getElementById('tenant-id').value;
  const body = {
    room_id: currentState.selectedRoomId,
    full_name: document.getElementById('tenant-name').value,
    phone: document.getElementById('tenant-phone').value,
    cccd: document.getElementById('tenant-cccd').value,
    start_date: document.getElementById('tenant-start-date').value,
    end_date: document.getElementById('tenant-end-date').value || null,
    notes: document.getElementById('tenant-notes').value
  };

  try {
    if (tenantId) {
      // Sửa
      await fetchAPI(`/api/tenants/${tenantId}`, {
        method: 'PUT',
        body: JSON.stringify(body)
      });
      showToast('Sửa thông tin người thuê thành công', 'success');
    } else {
      // Thêm mới
      await fetchAPI('/api/tenants', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      showToast('Thêm người thuê thành công', 'success');
    }

    document.getElementById('tenant-form').style.display = 'none';
    
    // Refresh modal
    refreshRoomModalData();
  } catch (err) {
    console.error(err);
  }
}

// Gọi mở form sửa Tenant
window.editTenant = function(tenant) {
  document.getElementById('tenant-id').value = tenant.id;
  document.getElementById('tenant-name').value = tenant.full_name;
  document.getElementById('tenant-phone').value = tenant.phone || '';
  document.getElementById('tenant-cccd').value = tenant.cccd || '';
  
  // Format dates for input date tag (YYYY-MM-DD)
  if (tenant.start_date) {
    document.getElementById('tenant-start-date').value = tenant.start_date.split('T')[0];
  }
  if (tenant.end_date) {
    document.getElementById('tenant-end-date').value = tenant.end_date.split('T')[0];
  } else {
    document.getElementById('tenant-end-date').value = '';
  }

  document.getElementById('tenant-notes').value = tenant.notes || '';
  document.getElementById('tenant-form-title').textContent = 'Sửa thông tin người thuê';
  document.getElementById('tenant-form').style.display = 'block';
};

// Gọi xóa Tenant
window.deleteTenant = async function(tenantId) {
  const isConfirmed = await showConfirm('Bạn có chắc chắn muốn xóa người thuê này ra khỏi phòng?');
  if (!isConfirmed) return;

  try {
    await fetchAPI(`/api/tenants/${tenantId}`, { method: 'DELETE' });
    showToast('Đã xóa người thuê thành công', 'success');
    refreshRoomModalData();
  } catch (err) {
    console.error("deleteTenant error:", err);
  }
};

// ==========================================
// 5. QUẢN LÝ ĐIỆN NĂNG (ELECTRICITY)
// ==========================================
function initElectricDateDropdowns() {
  const mSelect = document.getElementById('elec-month');
  const ySelect = document.getElementById('elec-year');
  
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  // Tạo tháng 1-12
  mSelect.innerHTML = '';
  for (let i = 1; i <= 12; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `Tháng ${i}`;
    if (i === currentMonth) opt.selected = true;
    mSelect.appendChild(opt);
  }

  // Tạo năm từ năm nay lùi lại 2 năm và tiến lên 1 năm
  ySelect.innerHTML = '';
  for (let i = currentYear - 2; i <= currentYear + 1; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `Năm ${i}`;
    if (i === currentYear) opt.selected = true;
    ySelect.appendChild(opt);
  }
}

async function loadRoomsDropdown() {
  try {
    const rooms = await fetchAPI('/api/rooms');
    const select = document.getElementById('elec-room-select');
    
    // Giữ lại option đầu tiên
    select.innerHTML = '<option value="">-- Chọn phòng --</option>';
    
    rooms.forEach(room => {
      const opt = document.createElement('option');
      opt.value = room.id;
      opt.textContent = `Phòng ${room.room_code} (Khu ${room.zone})`;
      select.appendChild(opt);
    });
  } catch (err) {
    console.error(err);
  }
}

async function loadElectricityReadingForRoom(roomId) {
  try {
    // 1. Lấy chỉ số mới nhất (để tự điền chỉ số cũ)
    const readingData = await fetchAPI(`/api/electricity/last-reading/${roomId}`);
    document.getElementById('elec-old').value = readingData.lastReading;
    document.getElementById('elec-new').value = ''; // Reset chỉ số mới
    document.getElementById('elec-calc-summary').style.display = 'none';

    // 2. Lấy danh sách lịch sử của phòng
    const roomDetails = await fetchAPI(`/api/rooms/${roomId}`);
    renderElectricHistoryTable(roomDetails.electricityHistory);
  } catch (err) {
    console.error(err);
  }
}

function renderElectricHistoryTable(history) {
  const tbody = document.getElementById('electric-history-table-body');
  tbody.innerHTML = '';

  if (history.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Chưa có lịch sử nhập số điện cho phòng này</td></tr>';
    return;
  }

  history.forEach(h => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>Tháng ${h.month}/${h.year}</strong></td>
      <td>${h.old_reading}</td>
      <td>${h.new_reading}</td>
      <td><span class="text-primary">${h.consumption} kWh</span></td>
      <td>${formatVND(h.unit_price)}</td>
      <td><strong>${formatVND(h.total_cost)}</strong></td>
    `;
    tbody.appendChild(tr);
  });
}

function calculateLiveElectricity() {
  const oldVal = parseFloat(document.getElementById('elec-old').value) || 0;
  const newVal = parseFloat(document.getElementById('elec-new').value) || 0;
  
  if (newVal >= oldVal) {
    const consumption = newVal - oldVal;
    const price = currentState.electricityPrice;
    const total = consumption * price;

    document.getElementById('calc-consumption').textContent = consumption.toFixed(1);
    document.getElementById('calc-unit-price').textContent = price.toLocaleString('vi-VN');
    document.getElementById('calc-total-cost').textContent = formatVND(total);
    
    document.getElementById('elec-calc-summary').style.display = 'block';
  } else {
    document.getElementById('elec-calc-summary').style.display = 'none';
  }
}

async function handleElectricitySubmit(e) {
  e.preventDefault();
  
  const body = {
    room_id: document.getElementById('elec-room-select').value,
    year: document.getElementById('elec-year').value,
    month: document.getElementById('elec-month').value,
    old_reading: document.getElementById('elec-old').value,
    new_reading: document.getElementById('elec-new').value
  };

  try {
    const result = await fetchAPI('/api/electricity', {
      method: 'POST',
      body: JSON.stringify(body)
    });

    showToast(`Lưu số điện thành công! Tháng ${body.month}/${body.year} tính hết ${formatVND(result.totalCost)}`, 'success');
    
    // Load lại lịch sử số điện
    loadElectricityReadingForRoom(body.room_id);
  } catch (err) {
    console.error(err);
  }
}

// ==========================================
// 6. TÌM KIẾM TOÀN CỤC (SEARCH TAB)
// ==========================================
async function triggerGlobalSearch() {
  const q = document.getElementById('search-input').value.trim();
  localStorage.setItem('searchQuery', q);
  if (!q) {
    document.getElementById('search-tenants-results').innerHTML = '<p class="text-muted text-center" style="padding: 20px;">Hãy nhập từ khóa tìm kiếm</p>';
    document.getElementById('search-rooms-results').innerHTML = '';
    document.getElementById('count-tenants').textContent = '0';
    document.getElementById('count-rooms').textContent = '0';
    return;
  }

  try {
    const results = await fetchAPI(`/api/search?q=${encodeURIComponent(q)}`);
    
    // Bind Tenants
    const tenantsContainer = document.getElementById('search-tenants-results');
    tenantsContainer.innerHTML = '';
    document.getElementById('count-tenants').textContent = results.tenants.length;

    if (results.tenants.length === 0) {
      tenantsContainer.innerHTML = '<p class="text-muted">Không tìm thấy người thuê nào</p>';
    } else {
      results.tenants.forEach(t => {
        const item = document.createElement('div');
        item.className = 'tenant-item';
        const start = t.start_date ? formatDate(t.start_date) : '--';
        const end = t.end_date ? formatDate(t.end_date) : 'Dài hạn';

        item.innerHTML = `
          <div class="tenant-main-info">
            <h4>${t.full_name} <span class="badge badge-occupied" style="cursor: pointer;" onclick="openRoomDetailModal(${t.room_id})">Phòng ${t.room_code} (Khu ${t.zone})</span></h4>
            <div class="tenant-meta">
              <span>📞 SĐT: <strong>${t.phone || 'Chưa nhập'}</strong></span>
              <span>🪪 CCCD: <strong>${t.cccd || 'Chưa nhập'}</strong></span>
              <span>📅 HĐ: ${start} ➔ ${end}</span>
            </div>
            ${t.notes ? `<div class="tenant-notes">📝 ${t.notes}</div>` : ''}
          </div>
        `;
        tenantsContainer.appendChild(item);
      });
    }

    // Bind Rooms
    const roomsContainer = document.getElementById('search-rooms-results');
    roomsContainer.innerHTML = '';
    document.getElementById('count-rooms').textContent = results.rooms.length;

    if (results.rooms.length === 0) {
      roomsContainer.innerHTML = '<p class="text-muted" style="grid-column: 1/-1;">Không tìm thấy phòng nào</p>';
    } else {
      results.rooms.forEach(room => {
        const card = document.createElement('div');
        card.className = `room-card status-${room.status}`;
        
        let statusText = 'Trống';
        if (room.status === 'occupied') statusText = 'Đang thuê';
        if (room.status === 'maintenance') statusText = 'Sửa chữa';

        const priceLabel = room.rent_price > 0 ? formatVND(room.rent_price) : 'Chưa đặt giá';

        card.innerHTML = `
          <div class="room-code">${room.room_code}</div>
          <div class="room-status">${statusText}</div>
          <div class="room-price">${priceLabel}</div>
          <div class="room-members">${room.member_count > 0 ? `👥 ${room.member_count} người` : 'Trống'}</div>
        `;

        card.addEventListener('click', () => openRoomDetailModal(room.id));
        roomsContainer.appendChild(card);
      });
    }

  } catch (err) {
    console.error(err);
  }
}

// ==========================================
// 7. THU TIỀN THÁNG (PAYMENTS TAB)  💰
// ==========================================

let paymentsData = []; // Cache dữ liệu để filter local

// Khởi tạo tab thu tiền (dropdowns tháng/năm)
function initPaymentsTab() {
  const mSelect = document.getElementById('pay-month-select');
  const ySelect = document.getElementById('pay-year-select');

  if (mSelect.options.length === 0) {
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    for (let i = 1; i <= 12; i++) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `Tháng ${i}`;
      if (i === currentMonth) opt.selected = true;
      mSelect.appendChild(opt);
    }

    for (let i = currentYear - 1; i <= currentYear + 1; i++) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `Năm ${i}`;
      if (i === currentYear) opt.selected = true;
      ySelect.appendChild(opt);
    }
  }

  // Tự động load tháng hiện tại khi vào tab lần đầu
  loadPaymentsData();
}

async function loadPaymentsData() {
  const month = document.getElementById('pay-month-select').value;
  const year = document.getElementById('pay-year-select').value;

  // Cập nhật tiêu đề
  document.getElementById('pay-month-display').textContent = `${month}/${year}`;

  try {
    const data = await fetchAPI(`/api/payments?year=${year}&month=${month}`);
    paymentsData = data;
    renderPaymentsTable(data);
    updatePaymentStats(data);

    // Reset filter về "Tất cả"
    document.querySelectorAll('.pay-filter-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.pay-filter-btn[data-filter="all"]').classList.add('active');
  } catch (err) {
    console.error(err);
  }
}

function updatePaymentStats(data) {
  const total = data.length;
  const paid = data.filter(r => r.is_paid === 1).length;
  const unpaid = data.filter(r => r.is_paid !== 1).length;

  const collectedAmt = data
    .filter(r => r.is_paid === 1)
    .reduce((sum, r) => sum + (r.total_amount || (r.rent_price + (r.electricity_amount || 0))), 0);

  const pendingAmt = data
    .filter(r => r.is_paid !== 1)
    .reduce((sum, r) => sum + r.rent_price + (r.electricity_amount || 0), 0);

  document.getElementById('pay-stat-total').textContent = `${total} phòng`;
  document.getElementById('pay-stat-paid').textContent = `${paid} phòng`;
  document.getElementById('pay-stat-collected-amount').textContent = formatVND(collectedAmt);
  document.getElementById('pay-stat-unpaid').textContent = `${unpaid} phòng`;
  document.getElementById('pay-stat-pending-amount').textContent = formatVND(pendingAmt);
}

function renderPaymentsTable(data) {
  const tbody = document.getElementById('payments-table-body');
  tbody.innerHTML = '';

  if (data.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center text-muted" style="padding: 40px;">
          ✅ Không có phòng nào đang thuê trong tháng này hoặc chưa có dữ liệu
        </td>
      </tr>
    `;
    return;
  }

  const month = document.getElementById('pay-month-select').value;
  const year = document.getElementById('pay-year-select').value;

  data.forEach(row => {
    const isPaid = row.is_paid === 1;
    const elecAmt = row.electricity_amount || 0;
    const rentAmt = row.rent_price || 0;
    const totalAmt = isPaid ? (row.total_amount || (rentAmt + elecAmt)) : (rentAmt + elecAmt);
    const tenantNames = row.tenant_names || 'Chưa có thông tin';
    const tenantPhones = row.tenant_phones || '';

    const tr = document.createElement('tr');
    tr.className = isPaid ? 'row-paid' : 'row-unpaid';
    tr.setAttribute('data-room-id', row.room_id);
    tr.setAttribute('data-paid', isPaid ? '1' : '0');

    tr.innerHTML = `
      <td>
        <strong>${row.room_code}</strong>
        <div style="font-size:11px;color:var(--neutral-gray)">Khu ${row.zone}</div>
      </td>
      <td>
        <div style="font-weight:500;">${tenantNames}</div>
        ${tenantPhones ? `<div style="font-size:12px;color:var(--neutral-gray)">📞 ${tenantPhones}</div>` : ''}
      </td>
      <td>${formatVND(rentAmt)}</td>
      <td>
        ${elecAmt > 0
          ? `<span class="text-primary">${formatVND(elecAmt)}</span>${row.consumption ? `<div style="font-size:11px;color:var(--neutral-gray)">${row.consumption} kWh</div>` : ''}`
          : '<span class="text-muted" style="font-size:12px;">Chưa nhập</span>'
        }
      </td>
      <td><span class="amount-total">${formatVND(totalAmt)}</span></td>
      <td>
        <span class="pay-status-badge ${isPaid ? 'paid' : 'unpaid'}">
          ${isPaid ? '✅ Đã thu' : '⏳ Chưa thu'}
        </span>
        ${isPaid && row.paid_at ? `<div style="font-size:10px;color:var(--neutral-gray);margin-top:3px;">Thu lúc: ${formatDateTime(row.paid_at)}</div>` : ''}
      </td>
      <td>
        ${isPaid
          ? `<button class="btn btn-sm btn-outline-secondary" onclick="markPayment(${row.room_id}, ${year}, ${month}, false)">↩ Hoàn trả</button>`
          : `<button class="btn btn-sm btn-success" onclick="markPayment(${row.room_id}, ${year}, ${month}, true)">✅ Đã thu tiền</button>`
        }
      </td>
    `;

    tbody.appendChild(tr);
  });
}

// Filter local không gọi API (hiệu năng tốt)
function filterPaymentRows(filter) {
  const rows = document.querySelectorAll('#payments-table-body tr[data-room-id]');
  rows.forEach(tr => {
    const isPaid = tr.getAttribute('data-paid') === '1';
    if (filter === 'all') {
      tr.style.display = '';
    } else if (filter === 'paid') {
      tr.style.display = isPaid ? '' : 'none';
    } else if (filter === 'unpaid') {
      tr.style.display = !isPaid ? '' : 'none';
    }
  });
}

// Đánh dấu đã thu / hoàn trả
window.markPayment = async function(roomId, year, month, isPaid) {
  if (!isPaid) {
    const isConfirmed = await showConfirm(`Bỏ đánh dấu đã thu tiền phòng này tháng ${month}/${year}?`);
    if (!isConfirmed) return;
  }

  try {
    const result = await fetchAPI('/api/payments/mark', {
      method: 'POST',
      body: JSON.stringify({ room_id: roomId, year, month, is_paid: isPaid })
    });

    showToast(
      isPaid
        ? `✅ Đã thu tiền! Tổng: ${formatVND(result.totalAmount)}`
        : '↩️ Đã bỏ đánh dấu thu tiền',
      isPaid ? 'success' : 'info'
    );

    // Reload lại bảng và stats
    loadPaymentsData();
  } catch (err) {
    console.error(err);
  }
};

// Format datetime ngắn gọn
function formatDateTime(dtString) {
  if (!dtString) return '';
  const d = new Date(dtString);
  if (isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm} ${hh}:${min}`;
}

