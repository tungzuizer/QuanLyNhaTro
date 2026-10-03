#!/data/data/com.termux/files/usr/bin/bash
# ==============================================================================
# SCRIPT TỰ ĐỘNG KHỞI CHẠY AI OCR SERVER & CLOUDFLARE QUICK TUNNEL TRÊN TERMUX
# Thiết bị: Điện thoại Samsung chạy 24/7 (kể cả hỏng màn hình)
# ==============================================================================

PROJECT_DIR="$HOME/QuanLyNhaTro/ocr-backend"
RENDER_SYNC_URL="https://quanlynhatro-10ar.onrender.com/api/settings/ai-tunnel-url"
LOG_DIR="$HOME/logs"
mkdir -p "$LOG_DIR"

echo "========================================================"
echo "🚀 [LISO OCR] Bắt đầu khởi động hệ thống AI trên điện thoại..."
echo "========================================================"

# 1. Bật OpenSSH để tiện điều khiển từ xa qua máy tính (port 8022)
if ! pgrep -x "sshd" > /dev/null; then
    echo "🔑 Khởi động SSH Server (port 8022)..."
    sshd
fi

# 2. Khởi động OmniRoute AI Gateway (port 20128) nếu chưa chạy
if ! pgrep -f "omniroute" > /dev/null; then
    echo "🤖 Khởi động OmniRoute AI Gateway..."
    # Lệnh chạy OmniRoute tùy cấu hình cài đặt
    if command -v omniroute &> /dev/null; then
        nohup omniroute > "$LOG_DIR/omniroute.log" 2>&1 &
    fi
fi

# 3. Khởi động Python FastAPI OCR Backend (port 8000)
cd "$PROJECT_DIR" || exit 1
export OMNIROUTE_API_KEY="sk-5f238e76072d7926-f6ac33-f145b936"
export OMNIROUTE_MODEL="antigravity/gemini-3.7-flash-high"

# Kill tiến trình uvicorn cũ nếu còn sót
pkill -f "uvicorn main:app" 2>/dev/null
sleep 1

echo "⚡ Khởi động FastAPI OCR Server (port 8000)..."
nohup python -m uvicorn main:app --host 0.0.0.0 --port 8000 > "$LOG_DIR/ocr_backend.log" 2>&1 &
sleep 2

# 4. Khởi động Cloudflare Quick Tunnel (Miễn phí 100%, không cần thẻ Visa, không cần đăng nhập)
echo "🌐 Khởi tạo Cloudflare Quick Tunnel..."
pkill -f "cloudflared tunnel" 2>/dev/null
sleep 1

CLOUDFLARE_LOG="$LOG_DIR/cloudflared.log"
rm -f "$CLOUDFLARE_LOG"

nohup cloudflared tunnel --url http://127.0.0.1:8000 > "$CLOUDFLARE_LOG" 2>&1 &

echo "⏳ Đang trích xuất địa chỉ Public Tunnel URL..."
TUNNEL_URL=""
for i in {1..30}; do
    sleep 2
    if [ -f "$CLOUDFLARE_LOG" ]; then
        TUNNEL_URL=$(grep -oE "https://[a-zA-Z0-9-]+\.trycloudflare\.com" "$CLOUDFLARE_LOG" | head -n 1)
        if [ -n "$TUNNEL_URL" ]; then
            break
        fi
    fi
    echo -n "."
done
echo ""

if [ -n "$TUNNEL_URL" ]; then
    echo "========================================================"
    echo "✅ CLOUDFLARE TUNNEL ĐÃ SẴN SÀNG:"
    echo "👉 $TUNNEL_URL"
    echo "========================================================"

    # 5. Tự động đồng bộ URL lên Render Server
    echo "📡 Đang đồng bộ URL lên Web Quản Lý Nhà Trọ (Render)..."
    SYNC_RESP=$(curl -s -X POST "$RENDER_SYNC_URL" \
        -H "Content-Type: application/json" \
        -d "{\"url\": \"$TUNNEL_URL\"}")

    echo "📩 Kết quả đồng bộ: $SYNC_RESP"
    echo "========================================================"
    echo "🎉 HỆ THỐNG ĐÃ SẴN SÀNG PHỤC VỤ CHỤP ẢNH CÔNG TƠ ĐIỆN!"
    echo "========================================================"
else
    echo "❌ Không lấy được URL Cloudflare Tunnel sau 60s. Vui lòng kiểm tra $CLOUDFLARE_LOG"
fi

# 6. Vòng lặp giám sát định kỳ (Watchdog Keep-Alive)
while true; do
    sleep 60
    # Kiểm tra xem FastAPI còn chạy không
    if ! pgrep -f "uvicorn main:app" > /dev/null; then
        echo "⚠️ FastAPI bị dừng, đang khởi động lại..."
        nohup python -m uvicorn main:app --host 0.0.0.0 --port 8000 >> "$LOG_DIR/ocr_backend.log" 2>&1 &
    fi

    # Kiểm tra xem Cloudflare Tunnel còn chạy không
    if ! pgrep -f "cloudflared tunnel" > /dev/null; then
        echo "⚠️ Cloudflare Tunnel bị ngắt, đang tạo kết nối mới..."
        nohup cloudflared tunnel --url http://127.0.0.1:8000 > "$CLOUDFLARE_LOG" 2>&1 &
        sleep 5
        NEW_URL=$(grep -oE "https://[a-zA-Z0-9-]+\.trycloudflare\.com" "$CLOUDFLARE_LOG" | head -n 1)
        if [ -n "$NEW_URL" ] && [ "$NEW_URL" != "$TUNNEL_URL" ]; then
            TUNNEL_URL="$NEW_URL"
            echo "🔄 Cập nhật Tunnel URL mới: $TUNNEL_URL"
            curl -s -X POST "$RENDER_SYNC_URL" \
                -H "Content-Type: application/json" \
                -d "{\"url\": \"$TUNNEL_URL\"}" > /dev/null
        fi
    fi
done
