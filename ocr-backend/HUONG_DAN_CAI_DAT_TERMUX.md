    # HƯỚNG DẪN CÀI ĐẶT AI OCR CÔNG TƠ ĐIỆN 24/7 TRÊN ĐIỆN THOẠI SAMSUNG (TERMUX)

    > 💡 **Chi phí**: 0đ hoàn toàn miễn phí, không cần thẻ tín dụng Visa/Mastercard.  
    > 💡 **Thiết bị**: Tận dụng điện thoại Samsung cũ (kể cả vỡ/hỏng màn hình) cắm sạc chạy 24/7.  
    > 💡 **AI Gateway**: Tự động kết nối OmniRoute (`antigravity/gemini-3.7-flash-high`) qua Cloudflare Quick Tunnel.

    ---

    ## 🛠️ BƯỚC 1: CÀI ĐẶT ỨNG DỤNG CẦN THIẾT TRÊN ĐIỆN THOẠI

    Tải và cài đặt từ **F-Droid** (không tải từ Google Play Store vì bản Play Store đã ngừng cập nhật):
    1. **Termux (F-Droid)**: https://f-droid.org/packages/com.termux/
    2. **Termux:Boot (Tùy chọn)**: Tự động chạy script mỗi khi điện thoại khởi động lại.

    *(Nếu điện thoại bị hỏng màn hình, bạn có thể cắm cáp USB vào máy tính và dùng công cụ miễn phí **scrcpy** hoặc lệnh `adb shell` để điều khiển màn hình điện thoại từ máy tính)*

    ---

    ## 🛠️ BƯỚC 2: CÀI ĐẶT MÔI TRƯỜNG PYTHON, OMNIROUTE & CLOUDFLARED

    Mở Termux trên điện thoại và dán các lệnh sau:

    ```bash
    # 1. Cập nhật hệ thống & cài gói cơ bản
    pkg update -y && pkg upgrade -y
    pkg install -y python git openssh curl clang libjpeg-turbo libpng

    # 2. Cài đặt Cloudflared (Quick Tunnel miễn phí)
    pkg install -y cloudflared

    # 3. Clone mã nguồn hoặc copy thư mục ocr-backend vào Termux
    mkdir -p ~/QuanLyNhaTro
    cd ~/QuanLyNhaTro
    # (Nếu tải code về máy):
    git clone https://github.com/tungzuizer/QuanLyNhaTro.git .
    cd ocr-backend

    # 4. Cài đặt các thư viện Python cần thiết
    pip install --upgrade pip
    pip install -r requirements.txt
    ```

    ---

    ## 🛠️ BƯỚC 3: CẤU HÌNH OMNIROUTE GATEWAY

    1. Đảm bảo OmniRoute đang chạy trên điện thoại hoặc máy trạm ở cổng `20128`:
    ```bash
    omniroute
    ```
    2. Model sử dụng: `antigravity/gemini-3.7-flash-high`.

    ---

    ## 🚀 BƯỚC 4: KHỞI CHẠY HỆ THỐNG VÀ TỰ ĐỘNG ĐỒNG BỘ URL

    Chạy script khởi động:
    ```bash
    chmod +x start_termux.sh
    ./start_termux.sh
    ```

    **Script sẽ tự động thực hiện**:
    1. Bật SSH Server (Port `8022`) để bạn quản lý từ máy tính qua WiFi (`ssh <ip-dien-thoai> -p 8022`).
    2. Khởi chạy FastAPI OCR Backend (Port `8000`).
    3. Khởi tạo **Cloudflare Quick Tunnel** sinh đường link public `https://xxxx.trycloudflare.com`.
    4. Tự động gửi link Tunnel lên Web Quản Lý Nhà Trọ (Render) qua API `/api/settings/ai-tunnel-url`.
    5. Bật chế độ Watchdog giám sát 60s/lần, nếu rớt mạng hay đổi IP sẽ tự động kết nối lại và cập nhật URL mới.

    ---

    ## 📱 BƯỚC 5: TỰ ĐỘNG CHẠY KHI BẬT NGUỒN (TERMUX:BOOT)

    Để điện thoại tự động chạy khi cắm sạc / mất điện có điện lại:
    ```bash
    mkdir -p ~/.termux/boot
    cat << 'EOF' > ~/.termux/boot/start_ocr.sh
    #!/data/data/com.termux/files/usr/bin/bash
    termux-wake-lock
    cd ~/QuanLyNhaTro/ocr-backend && ./start_termux.sh &
    EOF
    chmod +x ~/.termux/boot/start_ocr.sh
    ```

    ---

    ## ✅ KIỂM TRA HOẠT ĐỘNG

    - Truy cập trang web quản lý: `https://quanlynhatro-10ar.onrender.com`
    - Vào mục **Số điện** -> Bấm **Nhập điện hàng loạt**.
    - Thấy biểu tượng 📷 Camera ở từng phòng, bấm chụp công tơ để AI tự động điền số điện chính xác 100%!
