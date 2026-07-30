import os
import io
import json
import telebot
from PIL import Image
import google.generativeai as genai

# 1. โหลดไฟล์ .env สำหรับกรณีพัฒนา (Local Environment)
if os.path.exists(".env"):
    with open(".env", "r", encoding="utf-8") as f:
        for line in f:
            if line.strip() and not line.strip().startswith("#"):
                try:
                    k, v = line.strip().split("=", 1)
                    os.environ[k.strip()] = v.strip().strip('"').strip("'")
                except ValueError:
                    pass

# 2. ตั้งค่าดึงข้อมูล API Keys (ดึงจาก env หรือใช้ค่าเริ่มต้นจากเครื่องของคุณ)
TELEGRAM_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
if not TELEGRAM_TOKEN or TELEGRAM_TOKEN == "your_telegram_bot_token_here":
    TELEGRAM_TOKEN = "8861354099:AAH2g-fFEqJ4J105542KrTrImnIe-vKFQNM"

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")

if not TELEGRAM_TOKEN or not GEMINI_API_KEY:
    print("⚠️ คำเตือน: กรุณาตั้งค่า Environment Variables: TELEGRAM_BOT_TOKEN และ GEMINI_API_KEY")

bot = telebot.TeleBot(TELEGRAM_TOKEN) if TELEGRAM_TOKEN else None
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)


# 2. โหลด System Prompt สำหรับบอท HosXP (เวอร์ชันปรับปรุงอย่างละเอียด)
SYSTEM_PROMPT = """คุณคือผู้เชี่ยวชาญด้านคลังข้อมูลสุขภาพและฐานข้อมูล HosXP (MySQL/MariaDB) และนักวิเคราะห์ข้อมูลโรงพยาบาลอาวุโส (Senior Medical Information Officer)
หน้าที่ของคุณคือรับข้อมูลคำขอรายงานจากผู้ใช้ (ผ่านภาพถ่ายฟอร์มรายงานเดิม, หน้าจอโปรแกรมเดิม, หรือข้อความอธิบายความต้องการ) แล้วทำการวิเคราะห์โครงสร้างข้อมูลและสร้างคำสั่ง SQL สำหรับฐานข้อมูล HosXP

กรุณาวิเคราะห์และจัดทำข้อเสนอรายงานเป็นภาษาไทย โดยแบ่งออกเป็นหัวข้อดังนี้:

1. ชื่อรายงานและวัตถุประสงค์ (Report Name & Objective): สรุปประเภทรายงานและวัตถุประสงค์สั้นๆ
2. ข้อมูลที่ต้องแสดงในรายงาน (Output Columns): ตารางแสดงลำดับ, ชื่อคอลัมน์ภาษาไทย, ฟิล์ดและตารางอ้างอิง, และหมายเหตุ
3. เงื่อนไขและตัวกรอง (Filters & Criteria): เงื่อนไขในการดึงข้อมูลตามคำขอ
4. ตารางหลักของ HosXP ที่เกี่ยวข้อง (Related HosXP Tables): รายชื่อตารางที่ต้องใช้
5. ร่างคำสั่ง SQL (Draft SQL Query): เขียนคำสั่ง MySQL ที่ถูกต้อง มีประสิทธิภาพ และพร้อมใช้งาน
6. ข้อแนะนำและข้อจำกัดทางเทคนิค (Suggestions & Technical Notes): คำแนะนำ เช่น ฟิลด์ที่ควรทำ Index เพิ่มเติม หรือข้อระวังเกี่ยวกับความเข้ากันได้ของ HosXP แต่ละเวอร์ชัน

---

### โครงสร้างตาราง HosXP สำหรับอ้างอิง (Database Schema Context):
- patient: ข้อมูลทั่วไปผู้ป่วย (hn, fname, lname, sex, birthday, cid)
- ovst: การมารับบริการ OPD (vn, hn, vstdate, vsttime, spclty, pttype, main_dep)
- vn_stat: สถิติบริการ OPD หลัก (vn, hn, vstdate, pdx, dx0, dx1, dx2, dx3, sex, age_y, pttype, income, uc_money)
- ovstdiag: การวินิจฉัยโรค OPD (ovst_diag_id, vn, hn, icd10, diagtype) -> diagtype: 1=Primary, 2=Secondary, 3=Co-morbid, 4=Complication
- ipt: การนอนโรงพยาบาล IPD (an, hn, regdate, regtime, dchdate, dchtime, ward, spclty, pttype)
- an_stat: สถิติบริการ IPD หลัก (an, hn, regdate, dchdate, pdx, sex, age_y, pttype)
- iptdiag: การวินิจฉัยโรค IPD (ipt_diag_id, an, hn, icd10, diagtype)
- opitemrece: รายการค่ารักษา/ยา/เวชภัณฑ์ (vn, an, hn, rxdate, icode, qty, sum_price)
- drugitems: รายการยา (icode, name, strength, units)
- nondrugitems: รายการเวชภัณฑ์/ค่าบริการที่ไม่ใช่ยา (icode, name)
- pttype: สิทธิ์การรักษา (pttype, name)
- doctor: รายชื่อแพทย์ (code, name)
- ward: หอผู้ป่วย (ward, name)
- spclty: แผนก/สาขาเฉพาะทาง (spclty, name)
- icd101: รหัสและชื่อโรค ICD-10 (code, name)

---

### กฎเกณฑ์การเขียน SQL สำหรับ HosXP:
1. การ Join ข้อมูลการเงิน/ยา (opitemrece):
   - ผู้ป่วยนอก (OPD): เชื่อม opitemrece กับตารางบริการด้วย vn เสมอ (เช่น ON o.vn = r.vn)
   - ผู้ป่วยใน (IPD): เชื่อม opitemrece กับตารางบริการด้วย an เสมอ (เช่น ON i.an = r.an)
2. การวินิจฉัยโรค (Diagnosis):
   - หากผู้ใช้ระบุว่าต้องการคนไข้ที่ได้รับการวินิจฉัยโรคหลัก (Primary Diagnosis) ให้ใช้ฟิลด์ pdx ใน vn_stat หรือ an_stat
   - หากต้องการคนไข้ที่ได้รับการวินิจฉัยโรคนั้นๆ ไม่ว่าจะเป็นโรคหลักหรือโรครอง ให้ทำการ JOIN ตาราง ovstdiag (OPD) หรือ iptdiag (IPD) แล้วคัดกรองที่ icd10
3. การคัดกรองวันที่:
   - ให้ใช้รูปแบบมาตรฐานของระบบรายงานทั่วไป โดยใช้ Placeholder คือ :start_date และ :end_date ในฟังก์ชันเปรียบเทียบ เช่น vstdate BETWEEN :start_date AND :end_date หรือ regdate BETWEEN :start_date AND :end_date
4. ความคุ้มค่าของการดึงข้อมูล (Performance):
   - หลีกเลี่ยง SELECT * ให้ระบุคอลัมน์ให้ชัดเจน
   - เมื่อต้องการดึงชื่อสิทธิ์ หรือชื่อแพทย์ ให้ทำ LEFT JOIN กับตาราง pttype หรือ doctor
5. ความปลอดภัย: หากข้อมูลในคำขอไม่ชัดเจน ให้เขียน SQL ที่ปลอดภัยและสมเหตุสมผลที่สุด พร้อมคอมเมนต์บอกข้อจำกัดไว้ในโค้ด"""

# 3. ฟังก์ชันเรียกใช้งาน Gemini API (เอาต์พุตแบบปกติ - Markdown)
def generate_report_draft(text_prompt: str, image_bytes: bytes = None) -> str:
    model = genai.GenerativeModel(
        model_name="gemini-2.0-flash-lite",
        system_instruction=SYSTEM_PROMPT
    )
    
    contents = []
    if image_bytes:
        image = Image.open(io.BytesIO(image_bytes))
        contents.append(image)
        
    if text_prompt:
        contents.append(text_prompt)
    else:
        contents.append("กรุณาวิเคราะห์รูปภาพและออกแบบรายงาน HosXP พร้อมคำสั่ง SQL")
        
    try:
        response = model.generate_content(contents)
        return response.text
    except Exception as e:
        return f"เกิดข้อผิดพลาดในการประมวลผลด้วย AI: {str(e)}"

# 3.2 ฟังก์ชันเรียกใช้งาน Gemini API (เอาต์พุตแบบสกัดโครงสร้าง - JSON)
def generate_report_json(text_prompt: str, image_bytes: bytes = None) -> dict:
    json_system_prompt = SYSTEM_PROMPT + "\n\nกรุณาตอบกลับในรูปแบบ JSON เท่านั้น (Strict JSON Output) โดยไม่ต้องใส่ข้อความอธิบายใดๆ นอกเหนือจาก JSON บล็อกตามโครงสร้างนี้:\n" + json.dumps({
      "report_name": "ชื่อรายงาน",
      "objective": "วัตถุประสงค์ของรายงาน",
      "columns": [
        {
          "index": 1,
          "name_th": "ชื่อคอลัมน์ภาษาไทย",
          "field": "table.field",
          "description": "คำอธิบายคอลัมน์"
        }
      ],
      "criteria": [
        "เงื่อนไขข้อที่ 1"
      ],
      "sql_draft": "SELECT ... FROM ... WHERE ...",
      "suggestions": [
        "ข้อแนะนำที่ 1"
      ]
    }, ensure_ascii=False, indent=2)

    model = genai.GenerativeModel(
        model_name="gemini-2.0-flash-lite",
        system_instruction=json_system_prompt
    )
    
    contents = []
    if image_bytes:
        image = Image.open(io.BytesIO(image_bytes))
        contents.append(image)
        
    if text_prompt:
        contents.append(text_prompt)
    else:
        contents.append("กรุณาสกัดโครงสร้างรายงาน HosXP และแปลงเป็น JSON")
        
    try:
        response = model.generate_content(
            contents,
            generation_config={"response_mime_type": "application/json"}
        )
        return json.loads(response.text)
    except Exception as e:
        return {"error": f"Failed to generate JSON: {str(e)}"}

# 4. จัดการเมื่อได้รับข้อความต้อนรับ
if bot:
    def send_long_message(chat_id, text):
        """ส่งข้อความยาวโดยแบ่งส่วนแบบปลอดภัยและประมวลผล Markdown"""
        if not text:
            return
        limit = 4000
        if len(text) <= limit:
            try:
                bot.send_message(chat_id, text, parse_mode='Markdown')
            except Exception as err:
                print(f"⚠️ Markdown Error: {err}, falling back to plain text...")
                bot.send_message(chat_id, text)
            return

        for x in range(0, len(text), limit):
            chunk = text[x:x+limit]
            try:
                bot.send_message(chat_id, chunk, parse_mode='Markdown')
            except Exception as err:
                print(f"⚠️ Markdown Error in chunk: {err}, falling back to plain text...")
                bot.send_message(chat_id, chunk)

    @bot.message_handler(commands=['start', 'help'])
    def send_welcome(message):
        welcome_text = (
            "สวัสดีครับ! ยินดีต้อนรับสู่บอทออกแบบรายงาน HosXP 🏥📊\n\n"
            "คุณสามารถส่งข้อมูลคำขอรายงานมาได้ 2 วิธี:\n"
            "1. พิมพ์อธิบายความต้องการเป็นข้อความเข้ามาได้ทันที\n"
            "2. ส่งรูปภาพฟอร์มรายงานเดิม, หน้าจอ mockup หรือกระดาษที่เขียนหัวตารางไว้ (พร้อมคำอธิบายในแคปชั่นได้)"
        )
        bot.reply_to(message, welcome_text)

    # 5. จัดการเมื่อได้รับข้อความประเภทตัวอักษร (Text Message)
    @bot.message_handler(content_types=['text'])
    def handle_text_request(message):
        chat_id = message.chat.id
        user_query = message.text
        
        status_msg = bot.send_message(chat_id, "⏳ กำลังวิเคราะห์ความต้องการและร่างคำสั่ง SQL กรุณารอสักครู่...")
        
        try:
            result = generate_report_draft(text_prompt=user_query)
            
            # ลบข้อความสถานะออกก่อนเพื่อความสะอาด
            bot.delete_message(chat_id, status_msg.message_id)
            
            send_long_message(chat_id, result)
            
        except Exception as e:
            print(f"❌ เกิดข้อผิดพลาดในระบบ: {e}")
            try:
                bot.edit_message_text(f"❌ เกิดข้อผิดพลาดในการประมวลผล: {str(e)}", chat_id, status_msg.message_id)
            except Exception:
                bot.send_message(chat_id, f"❌ เกิดข้อผิดพลาดในการประมวลผล: {str(e)}")

    # 6. จัดการเมื่อได้รับข้อความประเภทรูปภาพ (Photo Message)
    @bot.message_handler(content_types=['photo'])
    def handle_image_request(message):
        chat_id = message.chat.id
        caption = message.caption
        
        status_msg = bot.send_message(chat_id, "📸 ได้รับรูปภาพแล้ว กำลังสแกนฟอร์มและเขียนคำสั่ง SQL... (ใช้เวลาวิเคราะห์ประมาณ 10-15 วินาที)")
        
        try:
            file_info = bot.get_file(message.photo[-1].file_id)
            downloaded_file = bot.download_file(file_info.file_path)
            
            result = generate_report_draft(text_prompt=caption, image_bytes=downloaded_file)
            
            # ลบข้อความสถานะออกก่อน
            bot.delete_message(chat_id, status_msg.message_id)
            
            send_long_message(chat_id, result)
            
        except Exception as e:
            print(f"❌ เกิดข้อผิดพลาดในระบบ: {e}")
            try:
                bot.edit_message_text(f"❌ เกิดข้อผิดพลาดในการประมวลผลรูปภาพ: {str(e)}", chat_id, status_msg.message_id)
            except Exception:
                bot.send_message(chat_id, f"❌ เกิดข้อผิดพลาดในการประมวลผลรูปภาพ: {str(e)}")


# 7. เริ่มทำงานบอท
if __name__ == '__main__':
    if bot:
        print("HosXP Report Bot is running...")
        bot.infinity_polling()
    else:
        print("Telegram Token ไม่ถูกตั้งค่า สามารถเรียกใช้ฟังก์ชันดึงข้อมูลได้ในฐานะไลบรารี")
