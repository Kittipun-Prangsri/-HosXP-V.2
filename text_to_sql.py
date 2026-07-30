#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import sys
import re
import mysql.connector
import google.generativeai as genai

# ตรวจสอบแพ็คเกจช่วยจัดรูปแบบตาราง (ถ้ามีให้เรียกใช้ ถ้าไม่มีให้ใช้ระบบจัดฟอร์แมตสำรอง)
try:
    from tabulate import tabulate
    HAS_TABULATE = True
except ImportError:
    HAS_TABULATE = False

# รหัสสี ANSI เพื่อความสวยงามพรีเมียมในช่อง Terminal
class Colors:
    HEADER = '\033[95m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    WARNING = '\033[93m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'
    UNDERLINE = '\033[4m'

# ======================================================================
# โหลดข้อมูลตัวแปรสภาวะแวดล้อมจาก .env
# ======================================================================
def load_env():
    if os.path.exists(".env"):
        with open(".env", "r", encoding="utf-8") as f:
            for line in f:
                if line.strip() and not line.strip().startswith("#"):
                    try:
                        k, v = line.strip().split("=", 1)
                        os.environ[k.strip()] = v.strip().strip('"').strip("'")
                    except ValueError:
                        pass

load_env()
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
DB_HOST = os.environ.get("HOSXP_DB_HOST", "127.0.0.1")
DB_PORT = int(os.environ.get("HOSXP_DB_PORT", "3306"))
DB_NAME = os.environ.get("HOSXP_DB_NAME", "hosxp")
DB_USER = os.environ.get("HOSXP_DB_USER", "root")
DB_PASS = os.environ.get("HOSXP_DB_PASS", "")

if not GEMINI_API_KEY:
    print(f"{Colors.WARNING}⚠️ ไม่พบ GEMINI_API_KEY ในไฟล์ .env{Colors.ENDC}")
    print(f"กรุณาใส่ API Key ของคุณในไฟล์ .env เพื่อใช้ระบบแปลภาษาเป็น SQL")
    sys.exit(1)

# ตั้งค่าเชื่อมต่อ Google Gemini
genai.configure(api_key=GEMINI_API_KEY)

# ======================================================================
# บริบทโครงสร้างตาราง HOSxP สำหรับเทรน AI บรรทัดต่อบรรทัด
# ======================================================================
SYSTEM_PROMPT = """คุณคือผู้เชี่ยวชาญระดับสูงด้านการวิเคราะห์ข้อมูลฐานข้อมูลโรงพยาบาล HOSxP (MySQL/MariaDB)
หน้าที่ของคุณคือการวิเคราะห์ประโยคคำขอรายงานภาษาไทยของเจ้าหน้าที่สาธารณสุข แล้วแปลงเป็นคำสั่ง SQL ที่ถูกต้อง มีประสิทธิภาพ ปลอดภัย และพร้อมทำงานบน MySQL HOSxP

### โครงสร้างตารางหลักของ HosXP สำหรับวิเคราะห์ (Schema Context):
- patient: ข้อมูลทั่วไปผู้ป่วย (hn, fname, lname, sex, birthday, cid)
- ovst: การมารับบริการ OPD (vn, hn, vstdate, vsttime, spclty, pttype, main_dep)
- vn_stat: สถิติการให้บริการ OPD (vn, hn, vstdate, pdx, dx0, dx1, dx2, dx3, age_y, pttype, income, uc_money)
- ovstdiag: การวินิจฉัยโรค OPD (vn, hn, icd10, diagtype) -> diagtype: 1=Primary, 2=Secondary
- ipt: การรับตัวเป็นผู้ป่วยใน IPD (an, hn, regdate, dchdate, ward, spclty, pttype)
- an_stat: สถิติผู้ป่วยใน IPD (an, hn, pdx, age_y, pttype)
- iptdiag: การวินิจฉัยโรค IPD (an, hn, icd10, diagtype)
- opitemrece: ธุรกรรม/การสั่งยาและเวชภัณฑ์ (vn, an, hn, rxdate, icode, qty, sum_price)
- drugitems: รายการยา (icode, name, strength, units)
- nondrugitems: รายการไม่ใช่ยา/เวชภัณฑ์ (icode, name)
- pttype: สิทธิการรักษา (pttype, name)
- doctor: แพทย์ (code, name)
- ward: หอผู้ป่วยใน (ward, name)
- spclty: แผนก/ห้องตรวจ (spclty, name)
- icd101: พจนานุกรมรหัสโรค ICD-10 (code, name)

### กฎสำคัญและแนวทางปฏิบัติในการสร้าง SQL:
1. การระบุสิทธิการรักษาหรือตึก/แผนก ให้ LEFT JOIN ตาราง pttype, ward, หรือ spclty เสมอเพื่อเอาชื่อภาษาไทยแสดงผล
2. การคำนวณราคายาหรือธุรกรรม: OPD ให้เชื่อมด้วย vn เสมอ, IPD ให้เชื่อมด้วย an เสมอ เพื่อไม่ให้ข้อมูลซ้ำซ้อน
3. การกรองช่วงวันที่: หากคำขอระบุเจาะจง ให้ใส่ตามนั้น แต่ถ้าเป็นคำขอทั่วไปให้ใช้ Placeholder ตัวแปรเงื่อนไข เช่น vstdate BETWEEN :start_date AND :end_date เพื่อให้ผู้ใช้สามารถระบุภายหลังได้ง่าย
4. ผลลัพธ์ต้องส่งกลับเฉพาะคำสั่ง SQL ในรูปแบบ Markdown code block เท่านั้น ห้ามใส่ข้อความเกริ่นนำหรือท้ายเรื่องใดๆ เช่น:
```sql
SELECT ...
```
5. การเขียน SQL ต้องเป็นแบบดึงข้อมูล (SELECT) เท่านั้น ห้ามทำการดัดแปลงข้อมูลเด็ดขาด (No INSERT/UPDATE/DELETE/DROP)
"""

def generate_sql(prompt):
    """ส่งข้อความความต้องการไปวิเคราะห์ผ่าน Gemini AI"""
    try:
        model = genai.GenerativeModel('gemini-1.5-flash', system_instruction=SYSTEM_PROMPT)
        response = model.generate_content(prompt)
        text = response.text.strip()
        
        # ค้นหาบล็อกโค้ดในกรณีที่ตอบกลับมาพร้อมข้อความอื่น
        match = re.search(r"```sql\s*(.*?)\s*```", text, re.DOTALL | re.IGNORECASE)
        if match:
            return match.group(1).strip()
        
        # ป้องกันหลุดการครอบบล็อกแต่วัตถุประสงค์ขึ้นต้นด้วย SQL ตรงๆ
        if text.lower().startswith("select") or text.lower().startswith("with"):
            return text
            
        return text
    except Exception as e:
        return f"เกิดข้อผิดพลาดด้าน AI: {e}"

def execute_query(sql):
    """รันคำสั่ง SQL จริงบนฐานข้อมูล HOSxP พร้อมดึงข้อมูลแสดงผลแบบตาราง"""
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=DB_PORT,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASS,
            charset='utf8',
            connect_timeout=5
        )
        cursor = conn.cursor()
        cursor.execute(sql)
        
        # ดึงรายชื่อหัวคอลัมน์
        columns = [desc[0] for desc in cursor.description]
        
        # ดึงข้อมูลสูงสุด 20 แถวแรกมาจำลอง
        rows = cursor.fetchmany(20)
        
        # ตรวจสอบจำนวนแถวทั้งหมด
        cursor.fetchall()
        total_found = cursor.rowcount if cursor.rowcount > 0 else len(rows)
        
        cursor.close()
        conn.close()
        
        return columns, rows, total_found, None
    except Exception as e:
        return None, None, 0, str(e)

def print_table(columns, rows):
    """แสดงผลตารางคอลัมน์ด้วยความสอดคล้องสูงสุด"""
    if not rows:
        return
        
    if HAS_TABULATE:
        print(f"\n{Colors.GREEN}{tabulate(rows, headers=columns, tablefmt='fancy_grid')}{Colors.ENDC}\n")
    else:
        # ระบบวาดตารางแบบสำรองกรณีเครื่องไม่มีไลบรารี tabulate
        col_widths = []
        for i in range(len(columns)):
            max_width = len(str(columns[i]))
            for r in rows:
                val_str = str(r[i]) if r[i] is not None else ""
                if len(val_str) > max_width:
                    max_width = len(val_str)
            col_widths.append(max_width)
            
        row_format = " | ".join([f"{{:<{w}}}" for w in col_widths])
        border = "-+-".join(["-" * w for w in col_widths])
        
        print(f"\n{Colors.GREEN}{row_format.format(*columns)}")
        print(border)
        for r in rows:
            r_str = [str(val) if val is not None else "" for val in r]
            print(row_format.format(*r_str))
        print(f"{Colors.ENDC}\n")

def main():
    print(f"{Colors.BOLD}{Colors.HEADER}================================================================{Colors.ENDC}")
    print(f"{Colors.BOLD}{Colors.HEADER}🏥 HOSxP AI Text-to-SQL Converter (ที่สุดฉลาด){Colors.ENDC}")
    print(f"{Colors.BOLD}{Colors.HEADER}================================================================{Colors.ENDC}")
    print(f"เชื่อมต่อฐานข้อมูล HOSxP: {Colors.CYAN}{DB_USER}@{DB_HOST}:{DB_PORT}/{DB_NAME}{Colors.ENDC}\n")
    
    # วิธีการประมวลผลหากรันผ่าน Arguments ตรงๆ
    if len(sys.argv) > 1:
        question = " ".join(sys.argv[1:])
        print(f"{Colors.BOLD}🔍 คำอธิบายที่ป้อนเข้ามา:{Colors.ENDC} {question}")
        print(f"⏳ กำลังประมวลผลแปลงเป็น SQL...")
        
        sql = generate_sql(question)
        
        print(f"\n{Colors.BOLD}{Colors.BLUE}💡 คำสั่ง SQL ที่ได้รับ:{Colors.ENDC}")
        print(f"{Colors.CYAN}{sql}{Colors.ENDC}\n")
        
        # ป้องกันคำสั่งลบหรือแก้ไขเพื่อความปลอดภัย
        sql_lower = sql.lower()
        if not (sql_lower.startswith("select") or sql_lower.startswith("with")):
            print(f"{Colors.FAIL}❌ ยกเลิกการรัน: ตัวช่วยรันอนุญาตเฉพาะการ SELECT และ WITH เท่านั้น{Colors.ENDC}")
            return
            
        run_opt = input("ต้องการทดลองคิวรีข้อมูลเพื่อดูผลลัพธ์ทันทีหรือไม่? (y/N): ").strip().lower()
        if run_opt == 'y':
            print("⏳ กำลังรันคิวรีข้อมูลบน HOSxP...")
            cols, rows, total, err = execute_query(sql)
            if err:
                print(f"{Colors.FAIL}❌ การดึงข้อมูลล้มเหลว: {err}{Colors.ENDC}")
            elif not rows:
                print(f"{Colors.WARNING}⚠️ สำเร็จ แต่ไม่พบรายการที่ตรงกับเงื่อนไขในระบบ{Colors.ENDC}")
            else:
                print_table(cols, rows)
                print(f"📊 แสดง 20 แถวแรก (จำนวนผลลัพธ์ทั้งหมดที่พบ: {total} แถว)")
        return

    # วิธีการประมวลผลโหมดพิมพ์คุยต่อเนื่อง (Interactive mode)
    print(f"พิมพ์ภาษาไทยบอกความต้องการรายงานที่ต้องการดึงข้อมูล (พิมพ์ {Colors.FAIL}exit{Colors.ENDC} หรือ {Colors.FAIL}q{Colors.ENDC} เพื่อจบการทำงาน)")
    print(f"ตัวอย่าง: {Colors.CYAN}ขอรายชื่อคนไข้ที่มาตรวจเมื่อวานสิทธิบัตรทอง{Colors.ENDC}")
    print(f"ตัวอย่าง: {Colors.CYAN}สรุปจํานวนผู้ป่วยนอกสะสมแยกตามแผนกห้องตรวจในปีนี้{Colors.ENDC}\n")
    
    while True:
        try:
            prompt = input(f"{Colors.BOLD}❓ ต้องการรายงานอะไร: {Colors.ENDC}").strip()
            if not prompt:
                continue
            if prompt.lower() in ['exit', 'quit', 'q']:
                print(f"{Colors.GREEN}ขอบคุณที่ใช้บริการขอรายงานระบบแปลภาษา!{Colors.ENDC}")
                break
                
            print(f"⏳ กำลังใช้ AI วิเคราะห์และสังเคราะห์ SQL...")
            sql = generate_sql(prompt)
            
            print(f"\n{Colors.BOLD}{Colors.BLUE}💡 คำสั่ง SQL จากปัญญาประดิษฐ์:{Colors.ENDC}")
            print(f"{Colors.CYAN}{sql}{Colors.ENDC}\n")
            
            # บล็อกคำสั่งทำลายล้าง
            sql_lower = sql.lower()
            if not (sql_lower.startswith("select") or sql_lower.startswith("with")):
                print(f"{Colors.FAIL}⚠️ ขออภัย เครื่องมือแปลภาษาอนุญาตเฉพาะคำสั่งดึงข้อมูล SELECT/WITH เท่านั้นเพื่อความปลอดภัย{Colors.ENDC}\n")
                continue
                
            run_opt = input("ต้องการทดลองรันคำสั่งเพื่อเช็คตัวอย่างข้อมูลหรือไม่? (y/N): ").strip().lower()
            if run_opt == 'y':
                print("⏳ กำลังรันประมวลผลฐานข้อมูล...")
                cols, rows, total, err = execute_query(sql)
                if err:
                    print(f"{Colors.FAIL}❌ เกิดความผิดพลาดทางโครงสร้าง SQL: {err}{Colors.ENDC}\n")
                elif not rows:
                    print(f"{Colors.WARNING}⚠️ การเชื่อมโยงข้อมูลสำเร็จ แต่ไม่พบคอลัมน์ข้อมูล{Colors.ENDC}\n")
                else:
                    print_table(cols, rows)
                    print(f"📊 แสดง 20 แถวแรก (จำนวนผลลัพธ์ทั้งหมดที่พบคิวรีนี้: {total} แถว)\n")
        except KeyboardInterrupt:
            print(f"\n{Colors.GREEN}ออกจากระบบแปลคำสั่ง{Colors.ENDC}")
            break

if __name__ == "__main__":
    main()
