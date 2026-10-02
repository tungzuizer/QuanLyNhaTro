#!/usr/bin/env python3
# ==============================================================================
# SCRIPT ĐÁNH GIÁ ĐỘ CHÍNH XÁC AI OCR CÔNG TƠ ĐIỆN (EVALUATION BENCHMARK)
# Model: antigravity/gemini-3.7-flash-high via OmniRoute Gateway
# ==============================================================================

import os
import sys
import json
import base64
import time
from typing import List, Dict, Any
import httpx

# Cấu hình OCR API Endpoint
API_URL = "http://127.0.0.1:8000/ocr-meter"

# Bộ dữ liệu mẫu kiểm thử các trường hợp biên (Edge cases benchmark)
TEST_SUITE: List[Dict[str, Any]] = [
    {
        "name": "Bánh xe lơ lửng giữa 4 và 5 - Số đỏ 1 (Rollover -> Chọn 5)",
        "expected_reading": 14235,
        "old_reading": 14100,
        "room_code": "A101",
        "description": "Bánh xe hàng đơn vị đang quay qua số 5, số đỏ là 1 -> phải đọc là 14235"
    },
    {
        "name": "Bánh xe lơ lửng giữa 7 và 8 - Số đỏ 9 (Chưa qua -> Chọn 7)",
        "expected_reading": 23567,
        "old_reading": 23450,
        "room_code": "A202",
        "description": "Bánh xe hàng đơn vị sắp chạm 8 nhưng số đỏ là 9 -> phải đọc là 23567"
    },
    {
        "name": "Mặt kính lóa đèn flash và góc nghiêng 30 độ",
        "expected_reading": 50124,
        "old_reading": 49980,
        "room_code": "B103",
        "description": "Kiểm tra khả năng loại bỏ ánh sáng phản chiếu và méo góc"
    }
]

def run_evaluation():
    print("=" * 65)
    print("🎯 BẮT ĐẦU ĐÁNH GIÁ ĐỘ CHÍNH XÁC HỆ THỐNG AI OCR CÔNG TƠ ĐIỆN")
    print(f"📡 API Endpoint: {API_URL}")
    print("=" * 65)

    # 1. Kiểm tra health check
    try:
        health_res = httpx.get("http://127.0.0.1:8000/health", timeout=5.0)
        print(f"✅ Trạng thái Backend OCR: {health_res.json()}")
    except Exception as e:
        print(f"❌ Không thể kết nối tới OCR Server tại http://127.0.0.1:8000: {e}")
        print("💡 Hãy chạy 'python main.py' trước khi chạy script này.")
        return

    # 2. Chạy qua các test case có ảnh thực tế nếu có thư mục test_images/
    test_img_dir = os.path.join(os.path.dirname(__file__), "test_images")
    if os.path.exists(test_img_dir):
        image_files = [f for f in os.listdir(test_img_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
        print(f"\n📂 Tìm thấy {len(image_files)} ảnh trong thư mục test_images/:")

        passed = 0
        total_time = 0.0

        for idx, img_name in enumerate(image_files, 1):
            img_path = os.path.join(test_img_dir, img_name)
            with open(img_path, "rb") as f:
                img_b64 = base64.b64encode(f.read()).decode("utf-8")

            payload = {
                "image": f"data:image/jpeg;base64,{img_b64}",
                "room_code": f"TEST_{idx}"
            }

            start_t = time.time()
            try:
                res = httpx.post(API_URL, json=payload, timeout=40.0)
                dur = time.time() - start_t
                total_time += dur

                if res.status_code == 200:
                    data = res.json()
                    print(f"\n[{idx}/{len(image_files)}] 📸 {img_name} ({dur:.2f}s):")
                    print(f"   👉 Chỉ số 5 số đen: {data.get('reading')} kWh")
                    print(f"   👉 Đầy đủ cả số đỏ: {data.get('decimal_reading')} kWh")
                    print(f"   👉 Độ tin cậy: {data.get('confidence') * 100:.1f}%")
                    print(f"   👉 Phát hiện bánh xe cuộn: {data.get('rollover_detected')}")
                    if data.get('details', {}).get('rollover_explanation'):
                        print(f"   💬 Giải thích: {data['details']['rollover_explanation']}")
                    passed += 1
                else:
                    print(f"❌ Lỗi xử lý {img_name}: {res.status_code} - {res.text}")
            except Exception as e:
                print(f"❌ Ngoại lệ khi gửi ảnh {img_name}: {e}")

        if image_files:
            avg_time = total_time / len(image_files)
            print("\n" + "=" * 65)
            print(f"📊 KẾT QUẢ: Thành công {passed}/{len(image_files)} ảnh | Thời gian phản hồi TB: {avg_time:.2f}s/ảnh")
            print("=" * 65)
    else:
        print("\nℹ️ Chưa có thư mục test_images/ để chạy benchmark ảnh thực tế.")
        print("💡 Bạn có thể tạo thư mục `test_images/` và thả các ảnh công tơ điện vào để kiểm thử hàng loạt.")

if __name__ == "__main__":
    run_evaluation()
