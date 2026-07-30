import os
import re
import base64
import urllib.request
import urllib.parse
import json
import datetime
import mysql.connector
import pandas as pd

# ======================================================================
# 1. โหลดไฟล์คอนฟิก .env
# ======================================================================
if os.path.exists(".env"):
    with open(".env", "r", encoding="utf-8") as f:
        for line in f:
            if line.strip() and not line.strip().startswith("#"):
                try:
                    k, v = line.strip().split("=", 1)
                    os.environ[k.strip()] = v.strip().strip('"').strip("'")
                except ValueError:
                    pass

# การดึงค่าคอนฟิก Web App API
WEB_APP_URL = os.environ.get("WEB_APP_URL")
API_SECRET_TOKEN = os.environ.get("API_SECRET_TOKEN", "hosxp_report_secret_2024")
if not API_SECRET_TOKEN or API_SECRET_TOKEN == "your_custom_secret_token_here":
    API_SECRET_TOKEN = "hosxp_report_secret_2024"

# การดึงค่าคอนฟิกฐานข้อมูล HOSxP MySQL
DB_HOST = os.environ.get("HOSXP_DB_HOST", "127.0.0.1")
DB_PORT = int(os.environ.get("HOSXP_DB_PORT", "3306"))
DB_NAME = os.environ.get("HOSXP_DB_NAME", "hosxp")
DB_USER = os.environ.get("HOSXP_DB_USER", "root")
DB_PASS = os.environ.get("HOSXP_DB_PASS", "")

def fetch_pending_requests():
    """ดึงข้อมูลคำขอรายงานที่มีสถานะ 'กำลังดำเนินการ' จาก Google Web App API"""
    if not WEB_APP_URL:
        print("❌ ข้อผิดพลาด: ไม่พบ WEB_APP_URL ในคอนฟิก")
        return []
    
    url = f"{WEB_APP_URL}?action=getPendingRequests"
    if API_SECRET_TOKEN:
        url += f"&token={urllib.parse.quote(API_SECRET_TOKEN)}"
        
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=15) as response:
            data = json.loads(response.read().decode('utf-8'))
            if data.get("success"):
                return data.get("requests", [])
            else:
                print(f"⚠️ ดึงข้อมูลล้มเหลว: {data.get('message')}")
    except Exception as e:
        print(f"❌ ดึงข้อมูลขัดข้องผ่าน Web App URL: {e}")
    return []

def extract_sql_query(admin_note):
    """ดึงคำสั่ง SQL ออกจากช่องบันทึกแอดมิน (ค้นหาบล็อกโค้ด ```sql ... ``` หรือ ```sql ...)"""
    if not admin_note:
        return None
    
    # 1. พยายามดึงข้อมูลจากบล็อก ```sql ... ``` (แบบปิดสมบูรณ์)
    match = re.search(r"```sql\s*(.*?)\s*```", admin_note, re.DOTALL | re.IGNORECASE)
    if match:
        return match.group(1).strip()
        
    # 2. พยายามดึงข้อมูลจากบล็อก ```sql ... (กรณีลืมพิมพ์ปิดท้าย)
    match_unclosed = re.search(r"```sql\s*(.*)", admin_note, re.DOTALL | re.IGNORECASE)
    if match_unclosed:
        return match_unclosed.group(1).strip()
    
    # 3. หากไม่พบบล็อกโค้ด แต่บันทึกขึ้นต้นด้วย select ตรงๆ ให้ใช้งาน
    cleaned_note = admin_note.strip()
    if cleaned_note.lower().startswith("select"):
        return cleaned_note
        
    return None

def process_date_placeholders(sql, date_from_str, date_to_str):
    """
    แปลงค่าวันที่ที่เป็น Placeholder ใน SQL เช่น :start_date, :end_date
    ให้เป็นค่าตามแบบฟอร์มคำขอจริง
    """
    if not sql:
        return sql
        
    # ล้าง Format วันที่ให้อยู่ในรูป YYYY-MM-DD
    # เช่น "2026-07-22T14:00:00.000Z" -> "2026-07-22"
    def clean_date(dt_str):
        if not dt_str:
            return ""
        return dt_str.split("T")[0]

    d_start = clean_date(date_from_str)
    d_end = clean_date(date_to_str)

    # ทำการแปลงแทนที่ค่า Placeholder ที่เป็นไปได้ทั้งหมด
    replacements = {
        ":start_date": f"'{d_start}'",
        ":end_date": f"'{d_end}'",
        ":start": f"'{d_start}'",
        ":end": f"'{d_end}'",
        ":date_start": f"'{d_start}'",
        ":date_end": f"'{d_end}'"
    }

    modified_sql = sql
    for placeholder, val in replacements.items():
        modified_sql = re.sub(placeholder, val, modified_sql, flags=re.IGNORECASE)
        
    return modified_sql

def validate_sql_query(sql):
    """
    ตรวจสอบความปลอดภัยของคำสั่ง SQL ป้องกันคำสั่งทำลายล้างหรือแก้ไขข้อมูลใน HOSxP
    อนุญาตเฉพาะคำสั่ง SELECT และ WITH เท่านั้น
    """
    if not sql:
        return False, "คำสั่ง SQL ว่างเปล่า"
        
    cleaned = sql.strip().lower()
    
    # อนุญาตเฉพาะ SELECT และ WITH
    if not (cleaned.startswith("select") or cleaned.startswith("with")):
        return False, "คำสั่ง SQL ต้องขึ้นต้นด้วย SELECT หรือ WITH เท่านั้น เพื่อความปลอดภัยของข้อมูลผู้ป่วย"
        
    # ค้นหาคีย์เวิร์ดที่ห้ามใช้ในการดึงรายงาน (เพื่อป้องกันการแก้ไขข้อมูล)
    forbidden_keywords = [
        r"\binsert\b", r"\bupdate\b", r"\bdelete\b", r"\bdrop\b", 
        r"\balter\b", r"\btruncate\b", r"\breplace\b", r"\bcreate\b", 
        r"\bgrant\b", r"\brevoke\b"
    ]
    
    for kw in forbidden_keywords:
        if re.search(kw, cleaned):
            clean_kw = kw.replace(r'\b', '')
            return False, f"พบคำสั่งต้องห้าม ({clean_kw}) ซึ่งไม่อนุญาตให้รันเพื่อความปลอดภัยสูงสุดของฐานข้อมูลโรงพยาบาล"
            
    return True, None

def run_query_and_export(sql, file_name):
    """เชื่อมต่อ MySQL HOSxP รันคำสั่ง SQL และส่งออกเป็น Excel"""
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=DB_PORT,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASS,
            charset='utf8'
        )
        print(f"🔌 เชื่อมต่อ HOSxP MySQL ({DB_HOST}:{DB_PORT}) สำเร็จ")
        
        # ดึงข้อมูลผ่าน Pandas
        df = pd.read_sql(sql, conn)
        
        # ปิดการเชื่อมต่อ
        conn.close()
        
        if df.empty:
            print("⚠️ คำแจ้งเตือน: รันผลลัพธ์ผ่านแต่ไม่พบแถวข้อมูล")
            
        # สร้างโฟลเดอร์สำหรับผลลัพธ์ชั่วคราว
        os.makedirs("completed_reports", exist_ok=True)
        local_path = os.path.join("completed_reports", file_name)
        
        # ส่งออกเป็น Excel (.xlsx)
        df.to_excel(local_path, index=False, engine='openpyxl')
        print(f"💾 ส่งออกไฟล์ชั่วคราวสำเร็จ: {local_path} (จำนวนข้อมูล {len(df)} แถว)")
        return local_path, None
        
    except Exception as e:
        print(f"❌ เกิดข้อผิดพลาดขณะรัน SQL ใน MySQL: {e}")
        return None, str(e)

def upload_report_to_drive(request_id, local_file_path):
    """ส่งไฟล์ที่ได้ขึ้น Google Drive ผ่าน API ของ Apps Script Web App เพื่อปิดงาน"""
    if not os.path.exists(local_file_path):
        print(f"❌ ไม่พบไฟล์ชั่วคราว: {local_file_path}")
        return False
        
    file_name = os.path.basename(local_file_path)
    
    try:
        with open(local_file_path, "rb") as f:
            base64_data = base64.b64encode(f.read()).decode("utf-8")
            
        payload = {
            "action": "updateRequestWithReport",
            "token": API_SECRET_TOKEN,
            "requestId": request_id,
            "fileData": base64_data,
            "fileName": file_name,
            "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        }
        
        req_data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            WEB_APP_URL,
            data=req_data,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0"
            },
            method="POST"
        )
        
        print(f"📤 กำลังอัปโหลดรายงานขึ้น Google Drive ของระบบ...")
        with urllib.request.urlopen(req, timeout=30) as response:
            res_json = json.loads(response.read().decode('utf-8'))
            if res_json.get("success"):
                print(f"✅ ปิดงานสำเร็จ! ลิงก์ดาวน์โหลด: {res_json.get('url')}")
                return True
            else:
                print(f"⚠️ ล้มเหลวตอนอัปเดตระบบ: {res_json.get('message')}")
    except Exception as e:
        print(f"❌ อัปโหลดขัดข้อง: {e}")
        
    return False

def report_error_to_web_app(request_id, error_message):
    """ส่งข้อความข้อผิดพลาดกลับไปอัปเดตสถานะของคำขอใน Apps Script Web App ให้เป็นปฏิเสธและใส่หมายเหตุ"""
    if not WEB_APP_URL:
        print("❌ ไม่พบ URL ของ Apps Script Web App")
        return False
        
    try:
        payload = {
            "action": "reportRequestError",
            "token": API_SECRET_TOKEN,
            "requestId": request_id,
            "errorMessage": error_message
        }
        
        req_data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            WEB_APP_URL,
            data=req_data,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0"
            },
            method="POST"
        )
        
        print(f"📤 กำลังส่งรายงานข้อผิดพลาด SQL กลับไปยังเซิร์ฟเวอร์...")
        with urllib.request.urlopen(req, timeout=15) as response:
            res_json = json.loads(response.read().decode('utf-8'))
            if res_json.get("success"):
                print(f"✅ อัปเดตสถานะเป็นขัดข้องและส่ง Error Log ไปยัง Sheets เรียบร้อย")
                return True
            else:
                print(f"⚠️ ไม่สามารถอัปเดต Error Log: {res_json.get('message')}")
    except Exception as e:
        print(f"❌ ส่งรายงานขัดข้องล้มเหลว: {e}")
        
    return False

def main():
    print(f"⏱️ เริ่มสแกนคำขอรายงานในระบบ ({datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')})")
    
    # 1. ดึงคำขอคิว "กำลังดำเนินการ"
    pending_list = fetch_pending_requests()
    if not pending_list:
        print("💤 ไม่มีรายงานที่ขึ้นสถานะ 'กำลังดำเนินการ' ให้ดำเนินการ")
        return
        
    print(f"🔍 พบรายงานที่ต้องดึงข้อมูลจำนวน {len(pending_list)} รายการ")
    
    for req in pending_list:
        req_id = req.get("id")
        req_no = req.get("requestNo")
        report_type = req.get("reportType")
        admin_note = req.get("adminNote")
        date_from = req.get("dateFrom")
        date_to = req.get("dateTo")
        
        print(f"\n──────────────────────────────────────────────────")
        print(f"📋 กำลังประมวลผลคำขอ #{req_no} (ID: {req_id})")
        print(f"👉 รายงาน: {report_type}")
        
        # 2. แกะโค้ด SQL จากบันทึก
        sql_query = extract_sql_query(admin_note)
        if not sql_query:
            print("⚠️ ข้าม: ไม่พบคำสั่ง SQL ที่ได้รับอนุมัติในบันทึกแอดมิน")
            continue
            
        # 3. จัดการตั้งวันที่ใน SQL
        sql_with_dates = process_date_placeholders(sql_query, date_from, date_to)
        print(f"📝 คำสั่ง SQL ที่จะใช้รัน:")
        print(f"---")
        print(sql_with_dates)
        print(f"---")
        
        # 3.5 ตรวจสอบความปลอดภัยของ SQL ป้องกันการเขียนแก้ไขข้อมูล (Security Validation)
        is_safe, validation_error = validate_sql_query(sql_with_dates)
        if not is_safe:
            print(f"🚨 ข้อผิดพลาดด้านความปลอดภัย: {validation_error}")
            report_error_to_web_app(req_id, f"ปฏิเสธเพื่อความปลอดภัย: {validation_error}")
            continue
        
        # 4. ดึงข้อมูลจริงจากฐานข้อมูลโรงพยาบาล
        file_name = f"Report_{req_no}_{datetime.date.today().strftime('%Y%m%d')}.xlsx"
        local_report_path, error_msg = run_query_and_export(sql_with_dates, file_name)
        
        # 5. ส่งกลับขึ้น Google Drive & เปลี่ยนคิวเป็นเสร็จสิ้น
        if local_report_path:
            success = upload_report_to_drive(req_id, local_report_path)
            if success:
                # ลบไฟล์ชั่วคราวทิ้งหลังอัปโหลดเสร็จเพื่อความปลอดภัยของข้อมูลผู้ป่วย
                try:
                    os.remove(local_report_path)
                    print(f"🗑️ ลบไฟล์ชั่วคราวฝั่ง Local เรียบร้อย")
                except Exception as ex:
                    print(f"⚠️ ลบไฟล์ชั่วคราวไม่สำเร็จ: {ex}")
            else:
                print("❌ ไม่สามารถอัปเดตไฟล์กลับเข้าสู่เซิร์ฟเวอร์คลาวด์ได้")
        else:
            # รัน SQL ล้มเหลว ส่งสถานะและ Error Message กลับไปที่ Web App
            report_error_to_web_app(req_id, error_msg)

if __name__ == "__main__":
    main()
