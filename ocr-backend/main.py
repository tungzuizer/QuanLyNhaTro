import os
import io
import re
import json
import base64
import logging
from typing import Optional, Dict, Any

from PIL import Image, ImageOps
import httpx
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Cấu hình logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("meter-ocr")

# Cấu hình OmniRoute Gateway
OMNIROUTE_URL = os.getenv("OMNIROUTE_URL", "http://127.0.0.1:20128/v1/chat/completions")
OMNIROUTE_API_KEY = os.getenv("OMNIROUTE_API_KEY", "sk-5f238e76072d7926-f6ac33-f145b936")
PRIMARY_MODEL = os.getenv("OMNIROUTE_MODEL", "antigravity/gemini-3.7-flash-high")
FALLBACK_MODEL = os.getenv("OMNIROUTE_FALLBACK_MODEL", "antigravity/claude-sonnet-4-6")

app = FastAPI(
    title="LISO Mechanical Electricity Meter OCR",
    description="Backend nhận diện chỉ số công tơ điện cơ khí 1 pha qua OmniRoute (Gemini Flash & Claude Sonnet Fallback)",
    version="1.1.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class MeterOCRRequest(BaseModel):
    image: str = Field(..., description="Ảnh công tơ điện định dạng Base64 (hoặc Data URI)")
    room_id: Optional[int] = Field(None, description="ID phòng")
    old_reading: Optional[float] = Field(None, description="Chỉ số điện cũ của phòng")
    room_code: Optional[str] = Field(None, description="Mã phòng (ví dụ: A101, B203)")

class MeterOCRResponse(BaseModel):
    success: bool
    reading: int = Field(..., description="Chỉ số điện nguyên (kWh) ghi nhận trên hóa đơn (5 số đen)")
    decimal_reading: float = Field(..., description="Chỉ số điện đầy đủ gồm cả số thập phân màu đỏ (kWh)")
    raw_digits: str = Field(..., description="Toàn bộ 6 chữ số nhìn thấy")
    confidence: float = Field(..., description="Độ tin cậy từ 0.0 đến 1.0")
    rollover_detected: bool = Field(False, description="Có phát hiện bánh xe số đang quay lỡ cỡ hay không")
    details: Dict[str, Any] = Field(default_factory=dict, description="Chi tiết 5 số đen, 1 số đỏ và giải thích")
    warning: Optional[str] = None

def preprocess_and_compress_image(base64_str: str) -> str:
    """
    Tiền xử lý ảnh:
    1. Bóc tách Data URI prefix nếu có.
    2. Tự động xoay ảnh chuẩn theo thông tin EXIF (chống chụp lộn ngược từ điện thoại).
    3. Giảm kích thước cạnh dài về tối đa 1200px để tối ưu dung lượng và token cho AI.
    4. Nén chất lượng JPEG 85 và chuyển đổi lại sang base64 data URI chuẩn.
    """
    if "," in base64_str:
        base64_str = base64_str.split(",", 1)[1]

    img_bytes = base64.b64decode(base64_str)
    img = Image.open(io.BytesIO(img_bytes))

    # Tự động xoay ảnh theo EXIF Orientation
    img = ImageOps.exif_transpose(img)

    # Chuyển đổi sang RGB nếu ảnh dạng RGBA hoặc Palette
    if img.mode in ("RGBA", "P"):
        img = img.convert("RGB")

    # Resize cạnh lớn nhất về 1200px (giữ nguyên tỷ lệ khung hình)
    max_dim = 1200
    w, h = img.size
    if max(w, h) > max_dim:
        if w > h:
            new_w = max_dim
            new_h = int(h * (max_dim / w))
        else:
            new_h = max_dim
            new_w = int(w * (max_dim / h))
        img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
        logger.info(f"Đã resize ảnh từ {w}x{h} về {new_w}x{new_h}")

    # Nén JPEG quality 85
    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", quality=85, optimize=True)
    compressed_base64 = base64.b64encode(buffer.getvalue()).decode("utf-8")
    return f"data:image/jpeg;base64,{compressed_base64}"

def build_ocr_prompt(old_reading: Optional[float] = None, room_code: Optional[str] = None) -> str:
    context_hint = ""
    if old_reading is not None and old_reading > 0:
        context_hint = f"\n- CHÚ Ý: Chỉ số điện cũ tháng trước của phòng này là: {int(old_reading)} kWh. Chỉ số mới thường bằng hoặc lớn hơn số cũ (mức tiêu thụ thông thường từ 10 đến 600 kWh/tháng)."

    if room_code:
        context_hint += f"\n- Mã phòng: {room_code}"

    prompt = f"""Bạn là một chuyên gia thị giác máy tính hàng đầu về nhận dạng công tơ điện cơ khí 1 pha tại Việt Nam (loại công tơ cơ khí Emic, Gelex, Vinakip 1 pha 2 dây).

Hãy quan sát thật kỹ bức ảnh công tơ điện được cung cấp và thực hiện nhận dạng chính xác dãy số chỉ số điện theo các quy tắc nghiêm ngặt sau:

### 1. CẤU TRÚC MẶT SỐ CÔNG TƠ CƠ KHÍ:
- Mặt số có tổng cộng **6 ô chữ số** hiển thị dạng bánh xe quay:
  + **5 Ô ĐẦU TIÊN (MÀU ĐEN)**: Biểu thị PHẦN NGUYÊN (đơn vị kWh). Đây là số chính thức dùng để tính tiền điện.
  + **1 Ô CUỐI CÙNG BÊN PHẢI (MÀU ĐỎ hoặc có viền đỏ/khung đỏ)**: Biểu thị PHẦN THẬP PHÂN (hàng 1/10 kWh, tương đương 0.1 kWh).

### 2. QUY TẮC XỬ LÝ BÁNH XE SỐ QUAY LỠ CỠ (ODOMETER ROLLOVER RULE - CỰC KỲ QUAN TRỌNG):
Vì là công tơ cơ khí bánh răng, các bánh xe số quay liên tục từ dưới lên trên. Khi một bánh xe số màu đen đang ở trạng thái chuyển giao (nằm lơ lửng ở giữa số N và N+1, ví dụ nhìn thấy nửa trên số 4 và nửa dưới số 5):
- **BẮT BUỘC KIỂM TRA CHỮ SỐ MÀU ĐỎ (Ô THẬP PHÂN BÊN PHẢI):**
  + Nếu chữ số màu đỏ đang ở khoảng từ **0 đến 2** (nghĩa là số đỏ vừa mới quay qua vạch 0): Bánh xe số màu đen đã hoàn thành chuyển số sang nấc mới -> **CHỌN SỐ LỚN HƠN (N+1)**.
  + Nếu chữ số màu đỏ đang ở khoảng từ **8 đến 9** (nghĩa là số đỏ sắp sửa chạm vạch 0 nhưng chưa tới): Bánh xe số màu đen chưa chuyển hẳn sang nấc mới -> **CHỌN SỐ NHỎ HƠN (N)**.
  + Nếu số đỏ ở khoảng từ 3 đến 7: Quan sát tỷ lệ hiển thị của vạch số nào nằm trọn vẹn hơn ở chính giữa khung cửa sổ.

### 3. ĐIỀU KIỆN ẢNH THỰC TẾ:
- Bỏ qua các vết bụi bẩn, lóa sáng phản chiếu trên mặt kính mica, góc nghiêng hoặc bóng đổ.
- Hãy tập trung vào đúng hàng 6 ô số của mặt hiển thị trung tâm.{context_hint}

### 4. ĐỊNH DẠNG ĐẦU RA (OUTPUT FORMAT):
Bạn BẮT BUỘC phải trả về kết quả dưới định dạng JSON thuần túy (không kèm bất kỳ văn bản giải thích nào ngoài JSON), theo đúng cấu trúc schema sau:
```json
{{
  "reading": 12345,
  "decimal_reading": 12345.6,
  "raw_digits": "123456",
  "confidence": 0.95,
  "rollover_detected": true,
  "details": {{
    "black_digits": "12345",
    "red_digit": "6",
    "rollover_explanation": "Bánh xe hàng đơn vị đang lơ lửng giữa 5 và 6, số đỏ là 6 nên chọn 5."
  }}
}}
```
- `reading`: Số nguyên (int) của 5 chữ số màu đen.
- `decimal_reading`: Số thực (float) đầy đủ cả 5 số đen + 1 số đỏ (ví dụ 12345.6).
- `raw_digits`: Chuỗi 6 chữ số nhìn thấy.
- `confidence`: Độ tin cậy nhận diện (0.0 đến 1.0).
- `rollover_detected`: Boolean (true nếu có bánh xe số nào đang quay dở giữa chừng).
"""
    return prompt

def get_omniroute_headers() -> Dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if OMNIROUTE_API_KEY:
        headers["Authorization"] = f"Bearer {OMNIROUTE_API_KEY}"
    return headers

@app.get("/health")
async def health_check():
    """Kiểm tra sức khỏe dịch vụ OCR và kết nối tới OmniRoute Gateway."""
    omniroute_status = "unknown"
    try:
        models_url = OMNIROUTE_URL.replace("/chat/completions", "/models")
        headers = {}
        if OMNIROUTE_API_KEY:
            headers["Authorization"] = f"Bearer {OMNIROUTE_API_KEY}"
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(models_url, headers=headers)
            if resp.status_code == 200:
                omniroute_status = "connected"
            else:
                omniroute_status = f"http_{resp.status_code}"
    except Exception as e:
        omniroute_status = f"offline ({str(e)})"

    return {
        "status": "ok",
        "service": "liso-meter-ocr",
        "primary_model": PRIMARY_MODEL,
        "fallback_model": FALLBACK_MODEL,
        "omniroute_gateway": omniroute_status
    }

@app.post("/ocr-meter", response_model=MeterOCRResponse)
async def ocr_meter(req: MeterOCRRequest):
    """
    Endpoint nhận ảnh công tơ điện và gọi model OCR qua OmniRoute.
    Ưu tiên: antigravity/gemini-3.7-flash-high.
    Nếu hết token / lỗi -> Tự động chuyển đổi sang model dự phòng: antigravity/claude-sonnet-4-6.
    """
    try:
        # 1. Tiền xử lý & nén ảnh
        processed_image_uri = preprocess_and_compress_image(req.image)
    except Exception as e:
        logger.error(f"Lỗi tiền xử lý ảnh: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Dữ liệu ảnh không hợp lệ: {str(e)}"
        )

    # 2. Xây dựng Prompt
    prompt_text = build_ocr_prompt(req.old_reading, req.room_code)

    # Danh sách model theo thứ tự ưu tiên
    candidate_models = [PRIMARY_MODEL]
    if FALLBACK_MODEL and FALLBACK_MODEL != PRIMARY_MODEL:
        candidate_models.append(FALLBACK_MODEL)

    last_error = None

    for idx, current_model in enumerate(candidate_models):
        logger.info(f"Đang thử nhận diện với model: {current_model} (Ưu tiên {idx + 1}/{len(candidate_models)})")

        payload = {
            "model": current_model,
            "temperature": 0.1,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt_text},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": processed_image_uri,
                                "detail": "high"
                            }
                        }
                    ]
                }
            ]
        }

        # 3. Gửi request tới OmniRoute Gateway
        try:
            async with httpx.AsyncClient(timeout=45.0) as client:
                res = await client.post(
                    OMNIROUTE_URL,
                    headers=get_omniroute_headers(),
                    json=payload
                )

            if res.status_code != 200:
                err_msg = f"Model {current_model} trả về lỗi HTTP {res.status_code}: {res.text[:200]}"
                logger.warning(err_msg)
                last_error = err_msg
                if idx + 1 < len(candidate_models):
                    logger.info(f"🔄 Chuyển sang model dự phòng: {candidate_models[idx + 1]}...")
                continue

            response_data = res.json()
            if "choices" not in response_data or not response_data["choices"]:
                err_msg = f"Model {current_model} không trả về choices hợp lệ: {response_data}"
                logger.warning(err_msg)
                last_error = err_msg
                continue

            content = response_data["choices"][0]["message"]["content"]
            logger.info(f"[{current_model}] AI Response raw: {content[:200]}...")

            # 4. Phân tích kết quả JSON
            json_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", content, re.DOTALL)
            if json_match:
                json_str = json_match.group(1)
            else:
                json_match = re.search(r"(\{.*\})", content, re.DOTALL)
                json_str = json_match.group(1) if json_match else content.strip()

            parsed = json.loads(json_str)

            reading = int(parsed.get("reading", 0))
            decimal_reading = float(parsed.get("decimal_reading", reading))
            raw_digits = str(parsed.get("raw_digits", str(reading)))
            confidence = float(parsed.get("confidence", 0.9))
            rollover_detected = bool(parsed.get("rollover_detected", False))
            details = parsed.get("details", {})
            details["model_used"] = current_model

            warning = None
            if req.old_reading is not None and reading < req.old_reading:
                warning = f"Chỉ số nhận diện ({reading}) nhỏ hơn chỉ số cũ ({int(req.old_reading)}). Vui lòng kiểm tra lại!"

            return MeterOCRResponse(
                success=True,
                reading=reading,
                decimal_reading=decimal_reading,
                raw_digits=raw_digits,
                confidence=confidence,
                rollover_detected=rollover_detected,
                details=details,
                warning=warning
            )

        except httpx.RequestError as exc:
            logger.error(f"Không thể kết nối tới OmniRoute Gateway khi gọi {current_model}: {exc}")
            last_error = f"Lỗi kết nối OmniRoute ({exc})"
            if idx + 1 < len(candidate_models):
                continue
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Không thể kết nối tới OmniRoute Gateway (port 20128). Vui lòng kiểm tra tiến trình OmniRoute trên máy."
            )
        except Exception as parse_err:
            logger.warning(f"Lỗi parse JSON với model {current_model}: {parse_err}. Thử trích xuất regex...")
            num_match = re.findall(r"\b\d{4,6}\b", content if 'content' in locals() else "")
            if num_match:
                fallback_val = int(num_match[0][:5])
                return MeterOCRResponse(
                    success=True,
                    reading=fallback_val,
                    decimal_reading=float(fallback_val),
                    raw_digits=num_match[0],
                    confidence=0.5,
                    rollover_detected=False,
                    details={"fallback_extracted": True, "model_used": current_model},
                    warning="Kết quả được trích xuất dự phòng do AI trả về định dạng văn bản."
                )
            last_error = f"Lỗi giải mã: {parse_err}"
            if idx + 1 < len(candidate_models):
                logger.info(f"🔄 Chuyển sang model dự phòng: {candidate_models[idx + 1]}...")
                continue

    raise HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail=f"Tất cả các model AI đều không thể nhận diện ảnh. Chi tiết lỗi cuối: {last_error}"
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
