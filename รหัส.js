// ============================================================
// HosXP Report Request System — Code.gs (Backend + LINE OA)
// Google Apps Script + Google Sheets + LINE Messaging API
// ============================================================

// ─── CONFIG ──────────────────────────────────────────────────
const SHEET_NAME_REQUESTS = "Requests";
const SHEET_NAME_USERS = "Users";
const SHEET_NAME_LOGS = "Logs";
const SHEET_NAME_HISTORY = "RequestHistory";

const ADMIN_ROLE = "admin";
const DOCTOR_ROLE = "doctor";
const SESSION_TTL_SECONDS = 6 * 60 * 60;

// 🚨 CONFIGURATION (ดึงข้อมูลจาก Script Properties เพื่อความปลอดภัย)
const scriptProperties = PropertiesService.getScriptProperties();

// LINE OA Config
const LINE_ACCESS_TOKEN = scriptProperties.getProperty("LINE_ACCESS_TOKEN") || "";
const LINE_ADMIN_GROUP_ID = scriptProperties.getProperty("LINE_ADMIN_GROUP_ID") || "Ud1ee9e2dd0d262fa7f6e6780f40df0c8";
const WEB_APP_URL = scriptProperties.getProperty("WEB_APP_URL") || "https://script.google.com/macros/s/AKfycbw218gf5IZqOzkoilIZBpISRFQ4o9aH6_B9pxPJuf70FORyuNFEV4y7csTCcC7rYYbE/exec"; // สำหรับปุ่มกดใน LINE

// Telegram Config
const TELEGRAM_BOT_TOKEN = scriptProperties.getProperty("TELEGRAM_BOT_TOKEN") || "";
const TELEGRAM_ADMIN_CHAT_ID = scriptProperties.getProperty("TELEGRAM_ADMIN_CHAT_ID") || "";

// ─── OFFLINE RULE-BASED MATCHING ENGINE ────────────────────────

/**
 * คลังเทมเพลตข้อมูลรายงาน HosXP แบบรวมศูนย์
 */
function getTemplates() {
  return [
    {
      id: "opd_visit",
      keywords: ["opd", "ผู้ป่วยนอก", "visit", "คนไข้นอก", "บริการ"],
      name: "📋 รายงานสถิติผู้ป่วยนอก (OPD)",
      objective: "รายงานสรุปจำนวนผู้มารับบริการผู้ป่วยนอก จำแนกตามแผนก สิทธิ์การรักษา และช่วงวันที่",
      columns: ["ลำดับ", "HN", "ชื่อ-สกุล", "วันที่มารับบริการ", "แผนก", "สิทธิ์การรักษา", "การวินิจฉัยหลัก (ICD-10)"],
      sql: "SELECT v.vn AS 'เลข VN', p.hn AS 'HN', CONCAT(p.fname, ' ', p.lname) AS 'ชื่อ-สกุล', v.vstdate AS 'วันที่', sp.name AS 'แผนก', pt.name AS 'สิทธิ์การรักษา', v.pdx AS 'การวินิจฉัยหลัก (ICD-10)' FROM vn_stat v LEFT JOIN patient p ON v.hn = p.hn LEFT JOIN spclty sp ON v.spclty = sp.spclty LEFT JOIN pttype pt ON v.pttype = pt.pttype WHERE v.vstdate BETWEEN :start_date AND :end_date ORDER BY v.vstdate, v.vn;",
      criteria: "vstdate BETWEEN :start_date AND :end_date",
      tables: "vn_stat, patient, spclty, pttype",
      notes: [
        "เปลี่ยน :start_date และ :end_date เป็นวันที่ต้องการ เช่น '2024-01-01'",
        "หากต้องการกรองแผนก เพิ่ม AND v.spclty = '<รหัสแผนก>'",
        "ตาราง vn_stat เหมาะสำหรับรายงานสถิติ เพราะมีดัชนีที่ดีกว่า ovst"
      ]
    },
    {
      id: "ipd_visit",
      keywords: ["ipd", "ผู้ป่วยใน", "นอนโรงพยาบาล", "admit", "discharge", "จำหน่าย", "ward"],
      name: "🛏️ รายงานสถิติผู้ป่วยใน (IPD)",
      objective: "รายงานสรุปการนอนโรงพยาบาล จำแนกตามหอผู้ป่วย วันที่รับ/จำหน่าย และการวินิจฉัย",
      columns: ["เลข AN", "HN", "ชื่อ-สกุล", "วันที่รับไว้", "วันที่จำหน่าย", "จำนวนวันนอน", "หอผู้ป่วย", "การวินิจฉัยหลัก"],
      sql: "SELECT a.an AS 'เลข AN', p.hn AS 'HN', CONCAT(p.fname, ' ', p.lname) AS 'ชื่อ-สกุล', a.regdate AS 'วันที่รับไว้', a.dchdate AS 'วันที่จำหน่าย', DATEDIFF(a.dchdate, a.regdate) AS 'จำนวนวันนอน', w.name AS 'หอผู้ป่วย', a.pdx AS 'การวินิจฉัยหลัก (ICD-10)' FROM an_stat a LEFT JOIN patient p ON a.hn = p.hn LEFT JOIN ward w ON a.ward = w.ward WHERE a.regdate BETWEEN :start_date AND :end_date ORDER BY a.regdate, a.an;",
      criteria: "regdate BETWEEN :start_date AND :end_date",
      tables: "an_stat, patient, ward",
      notes: [
        "เปลี่ยน :start_date และ :end_date เป็นวันที่ต้องการ",
        "หากต้องการกรอง ward ให้เพิ่ม AND a.ward = '<รหัส ward>'",
        "dchdate อาจเป็น NULL หากยังไม่จำหน่าย"
      ]
    },
    {
      id: "drug_usage",
      keywords: ["ยา", "drug", "เวชภัณฑ์", "รายการยา", "drugitems", "opitemrece", "ค่ายา", "จ่ายยา"],
      name: "💊 รายงานการจ่ายยา/เวชภัณฑ์",
      objective: "รายงานสรุปรายการยาและเวชภัณฑ์ที่จ่ายให้ผู้ป่วยในช่วงเวลาที่กำหนด",
      columns: ["วันที่", "HN", "ชื่อ-สกุล", "รหัสยา", "ชื่อยา", "จำนวน", "หน่วย", "ราคารวม"],
      sql: "SELECT r.rxdate AS 'วันที่จ่าย', p.hn AS 'HN', CONCAT(p.fname, ' ', p.lname) AS 'ชื่อ-สกุล', r.icode AS 'รหัสยา', d.name AS 'ชื่อยา', d.strength AS 'ความแรง', r.qty AS 'จำนวน', d.units AS 'หน่วย', r.sum_price AS 'ราคารวม (บาท)' FROM opitemrece r LEFT JOIN patient p ON r.hn = p.hn LEFT JOIN drugitems d ON r.icode = d.icode WHERE r.rxdate BETWEEN :start_date AND :end_date AND r.vn IS NOT NULL ORDER BY r.rxdate, r.hn;",
      criteria: "rxdate BETWEEN :start_date AND :end_date และ vn/an ไม่ใช่ NULL",
      tables: "opitemrece, patient, drugitems",
      notes: [
        "สำหรับ IPD เปลี่ยน vn IS NOT NULL เป็น an IS NOT NULL",
        "หากต้องการเฉพาะยาบางตัว เพิ่ม AND r.icode IN (...)",
        "ตาราง nondrugitems ใช้สำหรับค่าบริการที่ไม่ใช่ยา"
      ]
    },
    {
      id: "diagnosis",
      keywords: ["โรค", "icd", "วินิจฉัย", "diagnosis", "diag", "โรคหลัก", "โรครอง", "icd10"],
      name: "🩺 รายงานการวินิจฉัยโรค (ICD-10)",
      objective: "รายงานสรุปจำนวนผู้ป่วยจำแนกตามรหัสโรค ICD-10 ทั้งการวินิจฉัยหลักและรอง",
      columns: ["รหัสโรค (ICD-10)", "ชื่อโรค", "จำนวนผู้ป่วย OPD", "จำนวนครั้งที่พบ"],
      sql: "SELECT od.icd10 AS 'รหัสโรค', i.name AS 'ชื่อโรค', COUNT(DISTINCT od.hn) AS 'จำนวนผู้ป่วย (คน)', COUNT(od.ovst_diag_id) AS 'จำนวนครั้งที่พบ' FROM ovstdiag od LEFT JOIN vn_stat vs ON od.vn = vs.vn LEFT JOIN icd101 i ON od.icd10 = i.code WHERE vs.vstdate BETWEEN :start_date AND :end_date AND od.diagtype = 1 GROUP BY od.icd10, i.name ORDER BY COUNT(od.ovst_diag_id) DESC LIMIT 20;",
      criteria: "vstdate BETWEEN :start_date AND :end_date และ diagtype = 1 (โรคหลัก)",
      tables: "ovstdiag, vn_stat, icd101",
      notes: [
        "เปลี่ยน diagtype = 1 เป็น IN (1,2,3,4) หากต้องการโรครองด้วย",
        "สำหรับ IPD ใช้ตาราง iptdiag และ an_stat แทน"
      ]
    },
    {
      id: "revenue",
      keywords: ["รายได้", "ค่ารักษา", "เงิน", "income", "revenue", "ค่าบริการ", "ค่าใช้จ่าย", "billing", "ใบเสร็จ"],
      name: "💰 รายงานรายได้ค่ารักษาพยาบาล",
      objective: "รายงานสรุปรายได้ค่ารักษาพยาบาลจำแนกตามประเภทผู้ป่วยและสิทธิ์การรักษา",
      columns: ["วันที่", "สิทธิ์การรักษา", "จำนวนผู้ป่วย (คน)", "จำนวนครั้งบริการ", "รายได้รวม (บาท)"],
      sql: "SELECT vs.vstdate AS 'วันที่', pt.name AS 'สิทธิ์การรักษา', COUNT(DISTINCT vs.hn) AS 'จำนวนผู้ป่วย (คน)', COUNT(vs.vn) AS 'จำนวนครั้งบริการ', SUM(vs.income) AS 'รายได้รวม (บาท)' FROM vn_stat vs LEFT JOIN pttype pt ON vs.pttype = pt.pttype WHERE vs.vstdate BETWEEN :start_date AND :end_date GROUP BY vs.vstdate, vs.pttype, pt.name ORDER BY vs.vstdate, SUM(vs.income) DESC;",
      criteria: "vstdate BETWEEN :start_date AND :end_date",
      tables: "vn_stat, pttype",
      notes: [
        "ฟิลด์ income ใน vn_stat คือยอดรวมรายได้ต่อการมารับบริการ 1 ครั้ง",
        "ฟิลด์ uc_money คือส่วนที่ UC/บัตรทองรับผิดชอบ",
        "หากต้องการรายละเอียดเพิ่ม ให้ JOIN ตาราง opitemrece"
      ]
    },
    {
      id: "patient_info",
      keywords: ["ข้อมูลผู้ป่วย", "patient", "hn", "ประชากร", "ทะเบียน", "บัตรประชาชน", "cid", "ทะเบียนผู้ป่วย"],
      name: "👤 รายงานทะเบียนผู้ป่วย",
      objective: "รายงานข้อมูลพื้นฐานของผู้ป่วยที่ลงทะเบียนในระบบ",
      columns: ["HN", "ชื่อ", "นามสกุล", "เพศ", "วันเกิด", "อายุ", "เลขบัตรประชาชน"],
      sql: "SELECT p.hn AS 'HN', p.fname AS 'ชื่อ', p.lname AS 'นามสกุล', CASE p.sex WHEN '1' THEN 'ชาย' WHEN '2' THEN 'หญิง' ELSE 'ไม่ระบุ' END AS 'เพศ', p.birthday AS 'วันเกิด', TIMESTAMPDIFF(YEAR, p.birthday, CURDATE()) AS 'อายุ (ปี)', p.cid AS 'เลขบัตรประชาชน' FROM patient p WHERE p.hn IS NOT NULL ORDER BY p.hn;",
      criteria: "hn IS NOT NULL",
      tables: "patient",
      notes: [
        "ตาราง patient เป็นตารางหลักของผู้ป่วยทุกคนในระบบ",
        "ฟิลด์ sex: 1=ชาย, 2=หญิง",
        "birthday ใช้คำนวณอายุ"
      ]
    },
    {
      id: "lab",
      keywords: ["lab", "แล็บ", "ผลการตรวจ", "ตรวจเลือด", "ห้องแล็บ", "laboratory", "ผลแล็บ"],
      name: "🔬 รายงานผลการตรวจทางห้องปฏิบัติการ (Lab)",
      objective: "รายงานสรุปรายการตรวจและผลการตรวจทางห้องปฏิบัติการ",
      columns: ["วันที่", "HN", "ชื่อ-สกุล", "รายการตรวจ", "ผลการตรวจ", "หน่วย", "ค่าอ้างอิง"],
      sql: "SELECT lr.lab_order_date AS 'วันที่สั่ง', p.hn AS 'HN', CONCAT(p.fname, ' ', p.lname) AS 'ชื่อ-สกุล', li.lab_items_name AS 'รายการตรวจ', lrs.lab_result AS 'ผลการตรวจ', li.lab_items_unit AS 'หน่วย', li.lab_items_normal_value AS 'ค่าอ้างอิง' FROM lab_order lr LEFT JOIN patient p ON lr.hn = p.hn LEFT JOIN lab_result_list lrs ON lr.lab_order_number = lrs.lab_order_number LEFT JOIN lab_items li ON lrs.lab_items_number = li.lab_items_number WHERE lr.lab_order_date BETWEEN :start_date AND :end_date ORDER BY lr.lab_order_date, p.hn;",
      criteria: "lab_order_date BETWEEN :start_date AND :end_date",
      tables: "lab_order, patient, lab_result_list, lab_items",
      notes: [
        "ชื่อตาราง Lab อาจแตกต่างกันตามเวอร์ชัน HosXP",
        "ตรวจสอบโครงสร้างตารางแล็บของโรงพยาบาลก่อนใช้งาน"
      ]
    },
    {
      id: "appointment",
      keywords: ["นัด", "appointment", "นัดหมาย", "follow up", "followup", "นัดตรวจ"],
      name: "📅 รายงานการนัดหมาย",
      objective: "รายงานสรุปรายการผู้ป่วยที่มีการนัดหมาย จำแนกตามวันนัดและแผนก",
      columns: ["วันนัด", "HN", "ชื่อ-สกุล", "แผนกที่นัด", "หมายเหตุการนัด"],
      sql: "SELECT a.appoint_date AS 'วันนัด', p.hn AS 'HN', CONCAT(p.fname, ' ', p.lname) AS 'ชื่อ-สกุล', sp.name AS 'แผนกที่นัด', a.note AS 'หมายเหตุ' FROM oapp a LEFT JOIN patient p ON a.hn = p.hn LEFT JOIN spclty sp ON a.spclty = sp.spclty WHERE a.appoint_date BETWEEN :start_date AND :end_date ORDER BY a.appoint_date, sp.name;",
      criteria: "appoint_date BETWEEN :start_date AND :end_date",
      tables: "oapp, patient, spclty",
      notes: [
        "ตาราง oapp คือตารางการนัดหมายผู้ป่วยนอก",
        "note คือบันทึกเพิ่มเติมเกี่ยวกับการนัด"
      ]
    }
  ];
}

/**
 * ค้นหาและจับคู่รายงานสำเร็จรูปตามคำสำคัญ (Offline Rule Engine)
 */
function getAIResponseWithFallback(prompt, systemInstruction, history = []) {
  const query = prompt.toLowerCase();
  const templates = getTemplates();

  let bestMatch = null;
  let bestScore = 0;

  for (let i = 0; i < templates.length; i++) {
    let score = 0;
    const kw = templates[i].keywords;
    for (let j = 0; j < kw.length; j++) {
      if (query.indexOf(kw[j].toLowerCase()) !== -1) {
        score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = templates[i];
    }
  }

  // หากระบุ role เป็น admin หรือให้หา SQL
  const isAdmin = systemInstruction.indexOf("IT") !== -1 || systemInstruction.indexOf("MySQL") !== -1;

  if (bestMatch) {
    let aiText = "";
    const columnsText = bestMatch.columns.map((c, i) => `${i+1}. ${c}`).join("\n");
    const notesText = bestMatch.notes.map(n => `⚡ ${n}`).join("\n");

    if (isAdmin) {
      aiText = "### " + bestMatch.name + "\n" +
               "**1. วัตถุประสงค์ (Objective):**\n" + bestMatch.objective + "\n\n" +
               "**2. ข้อมูลที่ต้องแสดงในรายงาน (Output Columns):**\n" + columnsText + "\n\n" +
               "**3. เงื่อนไขและตัวกรอง (Filters & Criteria):**\n- " + bestMatch.criteria + "\n\n" +
               "**4. ตารางหลักของ HosXP ที่เกี่ยวข้อง (Related Tables):**\n- " + bestMatch.tables + "\n\n" +
               "**5. ร่างคำสั่ง SQL (Draft SQL Query):**\n```sql\n" + bestMatch.sql + "\n```\n\n" +
               "**6. ข้อแนะนำและข้อจำกัดทางเทคนิค (Suggestions):**\n" + notesText;
    } else {
      const columnsBullet = bestMatch.columns.map(c => `• ${c}`).join("\n");
      aiText = "สวัสดีครับ ผมเป็นระบบวิเคราะห์ความต้องการรายงานอัตโนมัติ 🏥\n" +
               "จากการวิเคราะห์คำขอของคุณ ดูเหมือนว่าคุณต้องการ: **" + bestMatch.name + "**\n\n" +
               "**รายละเอียดรายงาน:**\n" +
               "- **วัตถุประสงค์:** " + bestMatch.objective + "\n" +
               "- **คอลัมน์ที่แสดง:** \n" + columnsBullet + "\n\n" +
               "**คำแนะนำในการส่งข้อมูล:**\n" +
               "- กรุณาระบุช่วงวันที่ที่ต้องการให้ชัดเจน (เช่น 1 ม.ค. 67 ถึง 31 ม.ค. 67)\n" +
               "- หากมีตัวกรองเฉพาะ เช่น เฉพาะสิทธิ์ บัตรทอง/ข้าราชการ หรือระบุเฉพาะแพทย์ สามารถพิมพ์แจ้งไว้ในคำขอเพิ่มเติมได้เลยครับ";
    }
    return { success: true, text: aiText, provider: "OFFLINE_RULE_ENGINE" };
  }

  // Fallback เมื่อไม่เจอหัวข้อที่ตรง
  let fallbackText = "";
  if (isAdmin) {
    fallbackText = "### ❓ ไม่สามารถร่าง SQL ที่เหมาะสมได้อัตโนมัติ\n" +
                   "เนื่องจากระบบ Offline Rule Engine ตรวจไม่พบคำสำคัญ (Keywords) ที่คุ้นเคยในคำขอของคุณ\n\n" +
                   "**คำแนะนำเพิ่มเติม:**\n" +
                   "1. กรุณาตรวจสอบตารางพื้นฐานของ HOSxP เช่น `patient`, `ovst`, `vn_stat`, `an_stat`, `opitemrece`\n" +
                   "2. ตรวจสอบเงื่อนไขการเชื่อมต่อ (`JOIN`) และเขียน SQL ตามโครงสร้างความสัมพันธ์ของคุณเอง\n" +
                   "3. หากพิมพ์สอบถามในแชท ลองใช้คำสั้นๆ เช่น: `OPD`, `IPD`, `ค่ายา`, `วินิจฉัยโรค`, `นัดหมาย`, `ผลแล็บ`";
  } else {
    fallbackText = "สวัสดีครับ! ขออภัยด้วยครับที่ระบบยังไม่พบรายงานที่ตรงกับคำอธิบายของคุณโดยตรง 🏥\n\n" +
                   "**หัวข้อรายงานที่ระบบรองรับ:**\n" +
                   "• **ผู้ป่วยนอก (OPD)**: สถิติผู้ป่วยนอก, แผนก, จำนวน visit\n" +
                   "• **ผู้ป่วยใน (IPD)**: สถิติผู้ป่วยใน, หอผู้ป่วย (ward), วันนอน\n" +
                   "• **ยาและเวชภัณฑ์**: รายงานการจ่ายยา, ค่ายา, ประวัติจ่ายยา\n" +
                   "• **โรคและการวินิจฉัย**: รายงานสรุปโรค (ICD-10)\n" +
                   "• **การเงินและรายได้**: สถิติรายได้ค่ารักษาพยาบาล แยกตามสิทธิ์\n" +
                   "• **ทะเบียนผู้ป่วย**: ข้อมูลทั่วไป, HN, ค้นหาประวัติ\n" +
                   "• **ผลแล็บ (Lab)**: รายการตรวจห้องแล็บและผลการตรวจ\n" +
                   "• **นัดหมาย**: ตารางคิวนัดล่วงหน้า\n\n" +
                   "คุณสามารถพิมพ์คำสั้นๆ เช่น *\"รายงาน OPD\"* หรือ *\"ขอยอดค่ายา\"* เพื่อให้ระบบแนะนำได้ทันทีครับ!";
  }

  return { success: true, text: fallbackText, provider: "OFFLINE_RULE_ENGINE" };
}

/**
 * จำลองฟังก์ชันตรวจสอบระบบ AI
 */
function superDebugAI() {
  Logger.log("🚀 Offline Rule Engine ทำงานอย่างถูกต้อง ไม่จำเป็นต้องเชื่อมต่อ API ภายนอก");
}

/**
 * จำลองการเช็คค่า API Keys
 */
function checkApiSettings() {
  return "ระบบกำลังทำงานในโหมด Offline Rule Engine (ไม่ต้องใช้ API Key)";
}

// ─── ENTRY POINT (WEB APP) ───────────────────────────────────
function doGet(e) {
  // รองรับการรับส่งข้อมูลผ่าน API Web App สำหรับบอท
  if (e && e.parameter && e.parameter.action) {
    const apiToken = PropertiesService.getScriptProperties().getProperty("API_SECRET_TOKEN") || "hosxp_report_secret_2024";
    const clientToken = e.parameter.token || "";

    if (!apiToken || clientToken !== apiToken) {
      return ContentService.createTextOutput(JSON.stringify({ success: false, message: "Unauthorized: Invalid API Token" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const action = e.parameter.action;
    let result = { success: false, message: "Unknown action" };

    if (action === "getTemplates") {
      result = { success: true, templates: getTemplates() };
    } else if (action === "getPendingRequests") {
      // ดึงคำขอที่มีสถานะ "กำลังดำเนินการ" เพื่อไปรันดึงรายงานใน รพ. อัตโนมัติ
      const sheet = getSheet(SHEET_NAME_REQUESTS);
      const data = sheet.getDataRange().getValues();
      const parseData = (val) => (val instanceof Date) ? val.toISOString() : val;
      const pendingRows = [];

      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if ((row[10] || "").toString().trim() === "กำลังดำเนินการ") {
          pendingRows.push({
            id: parseData(row[0]),
            requestNo: parseData(row[1]),
            requesterName: parseData(row[2]),
            reportType: parseData(row[5]),
            dateFrom: parseData(row[6]),
            dateTo: parseData(row[7]),
            purpose: parseData(row[8]),
            urgency: parseData(row[9]),
            adminNote: parseData(row[11]), // มีคำสั่ง SQL ที่แอดมินอนุมัติแล้ว
            dataType: parseData(row[16] || ""),
            requestedFields: parseData(row[17] || ""),
            filterCondition: parseData(row[18] || ""),
            fileFormat: parseData(row[19] || "")
          });
        }
      }
      result = { success: true, requests: pendingRows };
    } else if (action === "analyze") {
      const query = e.parameter.query || "";
      const role = e.parameter.role || "doctor";

      const adminInstruction = `คุณคือ AI ผู้ช่วยอัจฉริยะสำหรับ IT ในการวิเคราะห์ตารางและเขียน SQL HOSxP (MySQL/MariaDB)
ทุกครั้งที่ให้ SQL ต้องครอบด้วย markdown code block (\`\`\`sql ... \`\`\`) และอธิบายเหตุผลสั้นๆ`;
      const userInstruction = "คุณคือ AI ผู้ช่วยอัจฉริยะสำหรับบุคลากรทางการแพทย์ในระบบขอรายงาน HosXP\n" +
        "ห้ามแสดง SQL หรือชื่อตารางเชิงเทคนิคให้ผู้ใช้เห็นเด็ดขาด ให้แนะนำวิธีอธิบายรายงานที่ดีและแนะนำการกรอกแบบฟอร์มขอรายงานแทน";

      const systemInstruction = role === "admin" ? adminInstruction : userInstruction;
      result = getAIResponseWithFallback(query, systemInstruction);
    }

    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return HtmlService
    .createTemplateFromFile("Index")
    .evaluate()
    .setTitle("ระบบขอรายงาน HosXP")
    .addMetaTag("viewport", "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ─── LINE WEBHOOK & AUTOMATION POST ENDPOINT ──────────────────
function doPost(e) {
  try {
    const rawBody = e.postData.contents;
    const json = JSON.parse(rawBody);

    // 1. ตรวจสอบหากเป็น Custom API Request จาก Python Script
    if (json && json.action) {
      const apiToken = PropertiesService.getScriptProperties().getProperty("API_SECRET_TOKEN") || "hosxp_report_secret_2024";
      const clientToken = json.token || "";
      if (!apiToken || clientToken !== apiToken) {
        return ContentService.createTextOutput(JSON.stringify({ success: false, message: "Unauthorized: Invalid API Token" }))
          .setMimeType(ContentService.MimeType.JSON);
      }

      if (json.action === "updateRequestWithReport") {
        ensureHeaders();
        const requestId = json.requestId;
        const base64Data = json.fileData;
        const fileName = json.fileName;
        const mimeType = json.mimeType;

        const uploadResult = uploadFileToDrive_(base64Data, fileName, mimeType, requestId);
        if (!uploadResult.success) {
          return ContentService.createTextOutput(JSON.stringify({ success: false, message: uploadResult.message }))
            .setMimeType(ContentService.MimeType.JSON);
        }

        const sheet = getSheet(SHEET_NAME_REQUESTS);
        const data = sheet.getDataRange().getValues();
        let updated = false;

        for (let i = 1; i < data.length; i++) {
          if (data[i][0] === requestId) {
            const previousStatus = data[i][10];
            sheet.getRange(i + 1, 11).setValue("เสร็จสิ้น"); // status (column 11)
            sheet.getRange(i + 1, 14).setValue(new Date()); // updatedAt (column 14)
            sheet.getRange(i + 1, 23).setValue(uploadResult.url); // downloadUrl (column 23)
            writeRequestHistory(requestId, data[i][1], "SYSTEM", "REPORT_UPLOADED", previousStatus, "เสร็จสิ้น", "อัปโหลดไฟล์รายงานอัตโนมัติ");
            updated = true;
            break;
          }
        }

        if (updated) {
          writeLog("SYSTEM", "API_REPORT_UPLOAD", `อัปเดตไฟล์รายงานสำเร็จสำหรับคำขอ ID: ${requestId}`);
          return ContentService.createTextOutput(JSON.stringify({ success: true, url: uploadResult.url }))
            .setMimeType(ContentService.MimeType.JSON);
        } else {
          return ContentService.createTextOutput(JSON.stringify({ success: false, message: "Request ID not found" }))
            .setMimeType(ContentService.MimeType.JSON);
        }
      }

      if (json.action === "reportRequestError") {
        ensureHeaders();
        const requestId = json.requestId;
        const errorMsg = json.errorMessage;

        const sheet = getSheet(SHEET_NAME_REQUESTS);
        const data = sheet.getDataRange().getValues();
        let updated = false;

        for (let i = 1; i < data.length; i++) {
          if (data[i][0] === requestId) {
            const previousStatus = data[i][10];
            sheet.getRange(i + 1, 11).setValue("ปฏิเสธ"); // status (column 11)
            sheet.getRange(i + 1, 12).setValue(`⚠️ ข้อผิดพลาดฐานข้อมูล SQL:\n${errorMsg}`); // adminNote (column 12)
            sheet.getRange(i + 1, 14).setValue(new Date()); // updatedAt (column 14)
            writeRequestHistory(requestId, data[i][1], "SYSTEM", "REPORT_ERROR", previousStatus, "ปฏิเสธ", `รัน SQL ล้มเหลว: ${errorMsg}`);
            updated = true;
            break;
          }
        }

        if (updated) {
          writeLog("SYSTEM", "API_REPORT_ERROR", `บันทึกข้อผิดพลาดสำหรับคำขอ ID: ${requestId}`);
          
          // ส่งไลน์แจ้งเตือนกลุ่มแอดมินเกี่ยวกับการรัน SQL พัง
          const alertMsg = `❌ <b>คำขอรันรายงานล้มเหลว</b>\n\n<b>ID:</b> ${requestId}\n<b>Error:</b> ${errorMsg}`;
          if (TELEGRAM_ADMIN_CHAT_ID) {
            sendTelegramNotification(TELEGRAM_ADMIN_CHAT_ID, alertMsg);
          }
          
          return ContentService.createTextOutput(JSON.stringify({ success: true }))
            .setMimeType(ContentService.MimeType.JSON);
        } else {
          return ContentService.createTextOutput(JSON.stringify({ success: false, message: "Request ID not found" }))
            .setMimeType(ContentService.MimeType.JSON);
        }
      }

      return ContentService.createTextOutput(JSON.stringify({ success: false, message: "Unknown action" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 2. ตรวจสอบลายเซ็น LINE Webhook (Signature Verification)
    const lineChannelSecret = PropertiesService.getScriptProperties().getProperty("LINE_CHANNEL_SECRET") || "";
    if (lineChannelSecret) {
      // ตรวจสอบความถูกต้องของ X-Line-Signature ใน Header
      const signature = e.headers && (e.headers['X-Line-Signature'] || e.headers['x-line-signature']);
      if (!signature) {
        writeLog("SECURITY_WARNING", "LINE_WEBHOOK_BLOCKED", "ตรวจไม่พบลายเซ็น X-Line-Signature");
        return ContentService.createTextOutput(JSON.stringify({ success: false, message: "Signature missing" }))
          .setMimeType(ContentService.MimeType.JSON);
      }

      const computedSignature = Utilities.base64Encode(
        Utilities.computeHmacSignature(
          Utilities.MacAlgorithm.HMAC_SHA_256,
          rawBody,
          lineChannelSecret,
          Utilities.Charset.UTF_8
        )
      );

      if (signature !== computedSignature) {
        writeLog("SECURITY_WARNING", "LINE_WEBHOOK_BLOCKED", "ลายเซ็น X-Line-Signature ไม่ถูกต้อง");
        return ContentService.createTextOutput(JSON.stringify({ success: false, message: "Invalid signature" }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    // 3. ประมวลผล LINE Webhook ตามปกติ
    const event = json.events[0];
    if (!event) return;

    const replyToken = event.replyToken;
    const messageText = event.message ? event.message.text : "";

    // ดึงค่า Source (มาจากห้องแชทไหน)
    const source = event.source;
    let targetId = "";
    let contextType = "";

    if (source.type === "group") {
      targetId = source.groupId;
      contextType = "Group ID";
    } else if (source.type === "room") {
      targetId = source.roomId;
      contextType = "Room ID";
    } else if (source.type === "user") {
      targetId = source.userId;
      contextType = "User ID";
    }

    // บันทึกลง Log ของระบบเพื่อให้มาดูย้อนหลังได้
    writeLog("LINE_WEBHOOK", "GET_ID", `ประเภท: ${contextType} | ID: ${targetId} | ข้อความ: ${messageText}`);

    // ถ้าพิมพ์คำว่า @id ให้พิมพ์ตอบกลับในไลน์กลุ่มนั้นทันที
    if (messageText.includes("@id")) {
      const responseText = `📌 ข้อมูล ID สำหรับระบบรายงาน:\n🔹 ประเภทแชท: ${contextType}\n🆔 ID ของท่าน: ${targetId}`;

      UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
        "method": "post",
        "headers": {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + LINE_ACCESS_TOKEN
        },
        "payload": JSON.stringify({
          "replyToken": replyToken,
          "messages": [{ "type": "text", "text": responseText }]
        })
      });
    }
  } catch (err) {
    writeLog("SYSTEM_ERROR", "LINE_WEBHOOK_CATCH", err.message);
  }
}

// ─── USER MANAGEMENT API ──────────────────────────────────────

/**
 * ดึงรายชื่อผู้ใช้ทั้งหมด (เฉพาะ Admin)
 */
function getUsers(sessionToken) {
  const session = requireSession(sessionToken, "", true);
  if (!session.ok) return { success: false, message: session.message };
  const sheet = getSheet(SHEET_NAME_USERS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  return {
    success: true,
    data: data.slice(1).map(row => {
      let obj = {};
      headers.forEach((h, i) => {
        let val = row[i];
        if (h === 'username' && val !== null && val !== undefined) {
          val = val.toString().trim();
        }
        if (h === 'password') {
          val = "_LEAVE_UNCHANGED_"; // Mask the password to client
        }
        obj[h] = val;
      });
      return obj;
    })
  };
}

/**
 * เพิ่มหรือแก้ไขผู้ใช้
 */
function saveUser(payload, sessionToken) {
  const session = requireSession(sessionToken, "", true);
  if (!session.ok) return { success: false, message: session.message };
  const sheet = getSheet(SHEET_NAME_USERS);
  const data = sheet.getDataRange().getValues();

  // ใช้ oldUsername ในการระบุแถวที่ต้องการแก้ไข (ถ้ามี) เพื่อรองรับการเปลี่ยน Username
  const targetUsername = (payload.oldUsername || payload.username).toString().trim();
  const newUsername = payload.username.trim();

  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString().trim() === targetUsername) {
      rowIndex = i + 1;
      break;
    }
  }

  let finalPassword = payload.password;
  if (rowIndex > 0) {
    const existingPasswordInSheet = data[rowIndex - 1][1]; // Column B
    if (payload.password === "_LEAVE_UNCHANGED_") {
      finalPassword = existingPasswordInSheet; // keep old hashed/plain password
    } else {
      finalPassword = hashPassword(payload.password); // hash new password
    }
  } else {
    // New user
    finalPassword = hashPassword(payload.password);
  }

  const rowData = [
    newUsername,
    finalPassword,
    payload.displayName,
    payload.email,
    payload.role,
    payload.department,
    payload.lineId ? payload.lineId.trim() : "",
    payload.telegramId ? payload.telegramId.trim() : ""
  ];

  if (rowIndex > 0) {
    sheet.getRange(rowIndex, 1, 1, 8).setValues([rowData]);
    writeLog("admin", "USER_UPDATE", `แก้ไขผู้ใช้: ${targetUsername} ${targetUsername !== newUsername ? '-> ' + newUsername : ''}`);
  } else {
    // กรณีเพิ่มใหม่ เช็คก่อนว่า Username ซ้ำไหม
    const exists = data.some(row => row[0] && row[0].toString().trim() === newUsername);
    if (exists) return { success: false, message: "ชื่อผู้ใช้นี้มีอยู่ในระบบแล้ว" };

    sheet.appendRow(rowData);
    writeLog("admin", "USER_CREATE", `เพิ่มผู้ใช้ใหม่: ${newUsername}`);
  }
  return { success: true };
}

/**
 * ลบผู้ใช้งานออกจากระบบ (เฉพาะ Admin)
 */
function deleteUser(usernameToDelete, currentUsername, currentRole, sessionToken) {
  try {
    const session = requireSession(sessionToken, currentUsername, true);
    if (!session.ok) return { success: false, message: session.message };
    if (usernameToDelete.toString().trim() === currentUsername.toString().trim()) {
      return { success: false, message: "ระบบป้องกันความปลอดภัย: ไม่สามารถลบ Account ของตัวเองได้" };
    }

    const sheet = getSheet(SHEET_NAME_USERS);
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] && data[i][0].toString().trim() === usernameToDelete.toString().trim()) {
        sheet.deleteRow(i + 1);
        writeLog(currentUsername, "USER_DELETE", `ลบผู้ใช้งาน: ${usernameToDelete}`);
        return { success: true };
      }
    }
    return { success: false, message: "ไม่พบผู้ใช้งานที่ต้องการลบ" };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ─── LINE TEST FUNCTION ───────────────────────────────────────

/**
 * ส่งข้อความทดสอบเข้า LINE Group/User ที่ตั้งค่าไว้
 */
function testLineNotification(targetId) {
  const toId = targetId || LINE_ADMIN_GROUP_ID;
  const testPayload = {
    type: "bubble",
    header: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: "⚡ LINE API TEST", weight: "bold", color: "#ffffff" }
      ],
      backgroundColor: "#333333"
    },
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: "การเชื่อมต่อสมบูรณ์!", weight: "bold", size: "md" },
        { type: "text", text: "ระบบพร้อมแจ้งเตือนแล้ว", size: "sm", color: "#666666", margin: "sm" },
        { type: "text", text: "เวลาทดสอบ: " + new Date().toLocaleString("th-TH"), size: "xs", color: "#999999", margin: "md" }
      ]
    }
  };

  sendLineNotification(toId, testPayload);
  return { success: true, message: "ส่งข้อความทดสอบแล้ว กรุณาเช็คใน LINE" };
}

// ─── SHEET HELPERS ───────────────────────────────────────────
function getSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

// อัปเดตตารางสิทธิ์ผู้ใช้และหัวข้อตารางส่งคำขอ
function ensureHeaders() {
  const reqSheet = getSheet(SHEET_NAME_REQUESTS);
  const expectedReqHeaders = [
    "id", "requestNo", "requesterName", "requesterEmail", "department",
    "reportType", "dateFrom", "dateTo", "purpose", "urgency",
    "status", "adminNote", "createdAt", "updatedAt", "createdBy",
    "requesterPhone", "dataType", "requestedFields", "filterCondition",
    "fileFormat", "neededDate", "additionalNote", "downloadUrl"
  ];

  if (reqSheet.getLastRow() === 0) {
    reqSheet.appendRow(expectedReqHeaders);
    reqSheet.getRange(1, 1, 1, expectedReqHeaders.length).setFontWeight("bold").setBackground("#1a73e8").setFontColor("#ffffff");
  } else {
    // อัปเดตโครงสร้างคอลัมน์เดิมหากมีไม่ครบ 23 ฟิลด์
    const currentHeaders = reqSheet.getRange(1, 1, 1, reqSheet.getLastColumn()).getValues()[0];
    if (currentHeaders.length < expectedReqHeaders.length) {
      reqSheet.getRange(1, currentHeaders.length + 1, 1, expectedReqHeaders.length - currentHeaders.length)
        .setValues([expectedReqHeaders.slice(currentHeaders.length)])
        .setFontWeight("bold").setBackground("#1a73e8").setFontColor("#ffffff");
    }
  }

  const usrSheet = getSheet(SHEET_NAME_USERS);
  const expectedUsrHeaders = ["username", "password", "displayName", "email", "role", "department", "lineId", "telegramId"];
  if (usrSheet.getLastRow() === 0) {
    usrSheet.appendRow(expectedUsrHeaders);
    usrSheet.getRange(1, 1, 1, expectedUsrHeaders.length).setFontWeight("bold").setBackground("#1a73e8").setFontColor("#ffffff");

    const seedData = [
      ["admin", hashPassword("admin1234"), "ผู้ดูแลระบบ", "admin@hospital.go.th", "admin", "IT", "", ""],
      ["doctor01", hashPassword("doc1234"), "นพ.สมชาย ใจดี", "doctor01@hospital.go.th", "doctor", "อายุรกรรม", "", ""],
      ["doctor02", hashPassword("doc1234"), "พญ.สมหญิง รักษาดี", "doctor02@hospital.go.th", "doctor", "ศัลยกรรม", "", ""],
      ["nurse01", hashPassword("nur1234"), "พยาบาล สมใจ", "nurse01@hospital.go.th", "doctor", "ห้องฉุกเฉิน", "", ""]
    ];
    usrSheet.getRange(2, 1, seedData.length, expectedUsrHeaders.length).setValues(seedData);
  } else {
    const currentHeaders = usrSheet.getRange(1, 1, 1, usrSheet.getLastColumn()).getValues()[0];
    if (currentHeaders.length < expectedUsrHeaders.length) {
      usrSheet.getRange(1, 1, 1, expectedUsrHeaders.length)
        .setValues([expectedUsrHeaders])
        .setFontWeight("bold").setBackground("#1a73e8").setFontColor("#ffffff");
    }
  }

  const logSheet = getSheet(SHEET_NAME_LOGS);
  if (logSheet.getLastRow() === 0) {
    logSheet.appendRow(["timestamp", "username", "action", "detail"]);
    logSheet.getRange(1, 1, 1, 4).setFontWeight("bold").setBackground("#1a73e8").setFontColor("#ffffff");
  }

  const historySheet = getSheet(SHEET_NAME_HISTORY);
  if (historySheet.getLastRow() === 0) {
    historySheet.appendRow(["timestamp", "requestId", "requestNo", "actor", "event", "fromStatus", "toStatus", "detail"]);
    historySheet.getRange(1, 1, 1, 8).setFontWeight("bold").setBackground("#1a73e8").setFontColor("#ffffff");
  }
}

function validateRequestPayload(payload) {
  const required = ["requesterName", "requesterEmail", "department", "reportType", "dateFrom", "dateTo", "purpose", "urgency"];
  for (let i = 0; i < required.length; i++) {
    if (!payload || !String(payload[required[i]] || "").trim()) return `กรุณากรอกข้อมูล ${required[i]} ให้ครบถ้วน`;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(payload.requesterEmail).trim())) return "รูปแบบอีเมลไม่ถูกต้อง";
  if (new Date(payload.dateFrom) > new Date(payload.dateTo)) return "วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด";
  if (["ปกติ", "สูง", "ด่วนที่สุด"].indexOf(String(payload.urgency)) === -1) return "ระดับความเร่งด่วนไม่ถูกต้อง";
  if (String(payload.reportType).length > 250 || String(payload.purpose).length > 3000) return "รายละเอียดคำขอยาวเกินกำหนด";
  return "";
}

function writeRequestHistory(requestId, requestNo, actor, event, fromStatus, toStatus, detail) {
  try {
    const sheet = getSheet(SHEET_NAME_HISTORY);
    sheet.appendRow([new Date().toISOString(), requestId, requestNo, actor, event, fromStatus || "", toStatus || "", detail || ""]);
  } catch (_) {}
}

// ─── AUTH ─────────────────────────────────────────────────────
function hashPassword(password) {
  if (!password) return "";
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password, Utilities.Charset.UTF_8);
  let hash = "";
  for (let i = 0; i < digest.length; i++) {
    let byteVal = digest[i];
    if (byteVal < 0) byteVal += 256;
    let byteString = byteVal.toString(16);
    if (byteString.length == 1) byteString = "0" + byteString;
    hash += byteString;
  }
  return hash;
}

function createSession(user) {
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, "");
  CacheService.getScriptCache().put("session:" + token, JSON.stringify(user), SESSION_TTL_SECONDS);
  return token;
}

function requireSession(token, username, adminOnly) {
  if (!token) return { ok: false, message: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่" };
  const raw = CacheService.getScriptCache().get("session:" + token);
  if (!raw) return { ok: false, message: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่" };
  const user = JSON.parse(raw);
  if (username && String(user.username) !== String(username)) return { ok: false, message: "เซสชันผู้ใช้ไม่ถูกต้อง" };
  if (adminOnly && user.role !== ADMIN_ROLE) return { ok: false, message: "ไม่มีสิทธิ์ดำเนินการ" };
  return { ok: true, user: user };
}

function login(username, password) {
  try {
    ensureHeaders();
    const sheet = getSheet(SHEET_NAME_USERS);
    const data = sheet.getDataRange().getValues();
    const inputPasswordHash = hashPassword(password);

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row[0] && row[0].toString().trim() === username.toString().trim()) {
        const storedPassword = row[1] ? row[1].toString().trim() : "";
        let passwordMatch = false;

        // Check if storedPassword is already a SHA-256 hash (64 hex characters)
        const isHashed = storedPassword.length === 64 && /^[0-9a-fA-F]+$/.test(storedPassword);

        if (isHashed) {
          passwordMatch = (storedPassword.toLowerCase() === inputPasswordHash.toLowerCase());
        } else {
          // Plain text comparison (migration path)
          passwordMatch = (storedPassword === password.toString().trim());
          if (passwordMatch) {
            // Upgrade plain text password in sheet to hashed password
            sheet.getRange(i + 1, 2).setValue(inputPasswordHash);
            writeLog(username, "SECURITY_UPGRADE", "อัปเกรดรหัสผ่านเป็นแบบแฮช SHA-256 สำเร็จ");
          }
        }

        if (passwordMatch) {
          writeLog(username, "LOGIN", "เข้าสู่ระบบสำเร็จ");
          const user = {
            username: row[0].toString().trim(),
            displayName: row[2], email: row[3], role: row[4], department: row[5],
            lineId: row[6] || "", telegramId: row[7] || ""
          };
          return {
            success: true,
            user: user,
            sessionToken: createSession(user)
          };
        }
      }
    }
    return { success: false, message: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" };
  } catch (e) {
    return { success: false, message: "เกิดข้อผิดพลาดระบบ: " + e.message };
  }
}

// ─── REQUESTS CRUD ───────────────────────────────────────────

function getRequests(username, role, displayName, sessionToken) {
  try {
    const session = requireSession(sessionToken, username);
    if (!session.ok) return { success: false, message: session.message };
    role = session.user.role;
    displayName = session.user.displayName;
    ensureHeaders();
    const sheet = getSheet(SHEET_NAME_REQUESTS);
    const data = sheet.getDataRange().getValues();

    const parseData = (val) => (val instanceof Date) ? val.toISOString() : val;

    let rows = data.slice(1).map(row => ({
      id: parseData(row[0]),
      requestNo: parseData(row[1]),
      requesterName: parseData(row[2]),
      requesterEmail: parseData(row[3]),
      department: parseData(row[4]),
      reportType: parseData(row[5]),
      dateFrom: parseData(row[6]),
      dateTo: parseData(row[7]),
      purpose: parseData(row[8]),
      urgency: parseData(row[9]),
      status: parseData(row[10]),
      adminNote: parseData(row[11]),
      createdAt: parseData(row[12]),
      updatedAt: parseData(row[13]),
      createdBy: (row[14] || "").toString().trim(),
      requesterPhone: parseData(row[15] || ""),
      dataType: parseData(row[16] || ""),
      requestedFields: parseData(row[17] || ""),
      filterCondition: parseData(row[18] || ""),
      fileFormat: parseData(row[19] || ""),
      neededDate: parseData(row[20] || ""),
      additionalNote: parseData(row[21] || ""),
      downloadUrl: parseData(row[22] || "")
    }));

    // ผู้ใช้ทั่วไปเห็นเฉพาะคำขอของตนเอง; ผู้ดูแลระบบเท่านั้นที่เห็นทุกคำขอ
    if (role !== ADMIN_ROLE) {
      const owner = String(displayName || "").trim();
      const loginName = String(username || "").trim();
      rows = rows.filter(r => r.createdBy === owner || r.createdBy === loginName);
    }

    return { success: true, data: rows.reverse() };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function createRequest(payload, username, sessionToken) {
  let lock;
  try {
    const session = requireSession(sessionToken, username);
    if (!session.ok) return { success: false, message: session.message };
    ensureHeaders();
    const validationError = validateRequestPayload(payload);
    if (validationError) return { success: false, message: validationError };
    lock = LockService.getScriptLock();
    lock.waitLock(5000);
    const userSheet = getSheet(SHEET_NAME_USERS);
    const userData = userSheet.getDataRange().getValues();

    let displayName = username;
    for (let i = 1; i < userData.length; i++) {
      if (userData[i][0].toString() === username.toString()) {
        displayName = userData[i][2];
        break;
      }
    }

    const sheet = getSheet(SHEET_NAME_REQUESTS);
    const id = Utilities.getUuid();
    const now = new Date().toISOString();
    const reqNo = generateRequestNo();

    sheet.appendRow([
      id,
      reqNo,
      payload.requesterName,
      payload.requesterEmail,
      payload.department,
      payload.reportType,
      payload.dateFrom,
      payload.dateTo,
      payload.purpose,
      payload.urgency,
      "รอดำเนินการ",
      "",
      now,
      now,
      displayName,
      payload.requesterPhone || "",
      payload.dataType || "",
      payload.requestedFields || "",
      payload.filterCondition || "",
      payload.fileFormat || "",
      payload.neededDate || "",
      payload.additionalNote || "",
      ""
    ]);

    writeLog(username, "CREATE", "สร้างคำขอโดย " + displayName);
    writeRequestHistory(id, reqNo, username, "CREATE", "", "รอดำเนินการ", "สร้างคำขอใหม่");

    // 🚀 ยิงแจ้งเตือนเข้า LINE OA ทันทีที่มีการสร้างคำขอใหม่
    payload.requestNo = reqNo;
    sendLineNotification(LINE_ADMIN_GROUP_ID, buildNewRequestFlex(payload));

    // 🚀 ยิงแจ้งเตือนเข้า Telegram แอดมิน (ถ้ากำหนดไว้)
    if (TELEGRAM_ADMIN_CHAT_ID) {
      const tgNewMsg = `📥 <b>มีคำขอรายงาน HosXP ใหม่</b>\n\n` +
        `<b>เลขที่คำขอ:</b> ${reqNo}\n` +
        `<b>รายงาน:</b> ${payload.reportType}\n` +
        `<b>ความเร่งด่วน:</b> ${payload.urgency}\n` +
        `<b>ผู้ขอ:</b> ${payload.requesterName} (${payload.department})\n` +
        `<b>ช่วงข้อมูล:</b> ${payload.dateFrom} ถึง ${payload.dateTo}\n` +
        `<b>รูปแบบไฟล์:</b> ${payload.fileFormat || "-"}\n` +
        `<b>วัตถุประสงค์:</b> ${payload.purpose}`;
      sendTelegramNotification(TELEGRAM_ADMIN_CHAT_ID, tgNewMsg);
    }

    return { success: true, id: id, requestNo: reqNo };
  } catch (e) {
    return { success: false, message: e.message };
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
  }
}

function getRequestHistory(requestId, username, role, displayName, sessionToken) {
  try {
    const session = requireSession(sessionToken, username);
    if (!session.ok) return { success: false, message: session.message };
    role = session.user.role;
    displayName = session.user.displayName;
    ensureHeaders();
    const requestRows = getSheet(SHEET_NAME_REQUESTS).getDataRange().getValues();
    const request = requestRows.slice(1).find(row => String(row[0]) === String(requestId));
    if (!request) return { success: false, message: "ไม่พบรายการ" };
    if (role !== ADMIN_ROLE && String(request[14] || "").trim() !== String(displayName || username || "").trim() && String(request[14] || "").trim() !== String(username || "").trim()) {
      return { success: false, message: "ไม่มีสิทธิ์ดูประวัติรายการนี้" };
    }
    const rows = getSheet(SHEET_NAME_HISTORY).getDataRange().getValues().slice(1)
      .filter(row => String(row[1]) === String(requestId))
      .map(row => ({ timestamp: row[0] instanceof Date ? row[0].toISOString() : row[0], actor: row[3], event: row[4], fromStatus: row[5], toStatus: row[6], detail: row[7] }));
    return { success: true, data: rows.reverse() };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function updateRequest(id, payload, username, role, sessionToken) {
  try {
    const session = requireSession(sessionToken, username);
    if (!session.ok) return { success: false, message: session.message };
    role = session.user.role;
    ensureHeaders();
    const sheet = getSheet(SHEET_NAME_REQUESTS);
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === id) {
        if (role !== ADMIN_ROLE) {
          if (data[i][14].toString().trim() !== username.toString().trim() && data[i][14].toString().trim() !== payload.requesterName.toString().trim()) {
            return { success: false, message: "ไม่มีสิทธิ์แก้ไขรายการนี้" };
          }
          if (data[i][10] !== "รอดำเนินการ") {
            return { success: false, message: "ไม่สามารถแก้ไขรายการที่ดำเนินการแล้ว" };
          }
        }

        const row = i + 1;
        const oldStatus = data[i][10];
        const createdBy = data[i][14];

        if (role === ADMIN_ROLE && payload.status && ["รอดำเนินการ", "กำลังดำเนินการ", "เสร็จสิ้น", "ปฏิเสธ"].indexOf(payload.status) === -1) {
          return { success: false, message: "สถานะคำขอไม่ถูกต้อง" };
        }
        if (payload.dateFrom && payload.dateTo && new Date(payload.dateFrom) > new Date(payload.dateTo)) {
          return { success: false, message: "วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด" };
        }

        sheet.getRange(row, 3).setValue(payload.requesterName || data[i][2]);
        sheet.getRange(row, 4).setValue(payload.requesterEmail || data[i][3]);
        sheet.getRange(row, 5).setValue(payload.department || data[i][4]);
        sheet.getRange(row, 6).setValue(payload.reportType || data[i][5]);
        sheet.getRange(row, 7).setValue(payload.dateFrom || data[i][6]);
        sheet.getRange(row, 8).setValue(payload.dateTo || data[i][7]);
        sheet.getRange(row, 9).setValue(payload.purpose || data[i][8]);
        sheet.getRange(row, 10).setValue(payload.urgency || data[i][9]);

        if (role === ADMIN_ROLE) {
          sheet.getRange(row, 11).setValue(payload.status || data[i][10]);
          sheet.getRange(row, 12).setValue(payload.adminNote !== undefined ? payload.adminNote : data[i][11]);
          sheet.getRange(row, 23).setValue(payload.downloadUrl !== undefined ? payload.downloadUrl : (data[i][22] || ""));
        }

        sheet.getRange(row, 14).setValue(new Date().toISOString());

        // บันทึกฟิลด์ที่พัฒนาเพิ่มเติม
        sheet.getRange(row, 16).setValue(payload.requesterPhone !== undefined ? payload.requesterPhone : (data[i][15] || ""));
        sheet.getRange(row, 17).setValue(payload.dataType !== undefined ? payload.dataType : (data[i][16] || ""));
        sheet.getRange(row, 18).setValue(payload.requestedFields !== undefined ? payload.requestedFields : (data[i][17] || ""));
        sheet.getRange(row, 19).setValue(payload.filterCondition !== undefined ? payload.filterCondition : (data[i][18] || ""));
        sheet.getRange(row, 20).setValue(payload.fileFormat !== undefined ? payload.fileFormat : (data[i][19] || ""));
        sheet.getRange(row, 21).setValue(payload.neededDate !== undefined ? payload.neededDate : (data[i][20] || ""));
        sheet.getRange(row, 22).setValue(payload.additionalNote !== undefined ? payload.additionalNote : (data[i][21] || ""));

        writeLog(username, "UPDATE", "แก้ไขคำขอ " + data[i][1]);
        if (role === ADMIN_ROLE && payload.status && payload.status !== oldStatus) {
          writeRequestHistory(data[i][0], data[i][1], username, "STATUS_CHANGE", oldStatus, payload.status, payload.adminNote || "");
        } else {
          writeRequestHistory(data[i][0], data[i][1], username, "UPDATE", oldStatus, oldStatus, "แก้ไขรายละเอียดคำขอ");
        }

        // 🚀 แจ้งเตือนกลุ่ม Admin กรณีผู้ใช้งานอัปเดตข้อมูลคำขอด้วยตนเอง
        if (role !== ADMIN_ROLE) {
          const editMsg = `✏️ <b>ผู้ใช้งานแก้ไขข้อมูลคำขอ</b>\n\n<b>เลขที่:</b> ${data[i][1]}\n<b>รายงาน:</b> ${payload.reportType || data[i][5]}`;
          sendLineNotification(LINE_ADMIN_GROUP_ID, {
            "type": "bubble",
            "body": {
              "type": "box", "layout": "vertical",
              "contents": [
                { "type": "text", "text": "✏️ ผู้ใช้แก้ไขข้อมูลคำขอ", "weight": "bold", "color": "#1A73E8" },
                { "type": "text", "text": `เลขที่: ${data[i][1]}`, "size": "sm" },
                { "type": "text", "text": `รายงาน: ${payload.reportType || data[i][5]}`, "size": "sm", "wrap": true }
              ]
            }
          });
          if (TELEGRAM_ADMIN_CHAT_ID) sendTelegramNotification(TELEGRAM_ADMIN_CHAT_ID, editMsg);
        }

        // 🚀 ระบบแจ้งเตือนอัจฉริยะเมื่อแอดมินอัปเดตสถานะงาน
        if (role === ADMIN_ROLE && payload.status && payload.status !== oldStatus) {
          const flexMessage = buildStatusUpdateFlex(
            data[i][1],
            payload.reportType || data[i][5],
            payload.status,
            payload.adminNote || "ไม่มี"
          );

          // 1. ส่งเข้ากลุ่มแอดมินกลาง
          sendLineNotification(LINE_ADMIN_GROUP_ID, flexMessage);

          // 2. ดึง LINE ID และ Telegram ID ของผู้แจ้ง เพื่อส่งข้อความทักไปบอกส่วนตัว
          const userSheet = getSheet(SHEET_NAME_USERS);
          const uData = userSheet.getDataRange().getValues();
          for (let u = 1; u < uData.length; u++) {
            if (uData[u][2] === createdBy) {
              const uLineId = uData[u][6];
              const uTelegramId = uData[u][7];

              if (uLineId) {
                sendLineNotification(uLineId, flexMessage); // ยิงหา LINE ID ของผู้ใช้คนนั้น
              }

              if (uTelegramId) {
                const tgMsg = `🔄 <b>อัปเดตสถานะคำขอรายงาน</b>\n\n` +
                  `<b>เลขที่คำขอ:</b> ${data[i][1]}\n` +
                  `<b>รายงาน:</b> ${payload.reportType || data[i][5]}\n` +
                  `<b>สถานะล่าสุด:</b> ${payload.status}\n` +
                  `<b>หมายเหตุไอที:</b> ${payload.adminNote || "ไม่มี"}`;
                sendTelegramNotification(uTelegramId, tgMsg); // ยิงแจ้งเตือนผ่าน Telegram
              }
              break;
            }
          }
        }
        return { success: true };
      }
    }
    return { success: false, message: "ไม่พบรายการ" };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ปรับปรุงระบบลบคำขอ: อนุญาตให้เจ้าของงานลบได้ ถ้างานยังไม่ถูกดำเนินงาน
function deleteRequest(id, username, role, sessionToken) {
  try {
    const session = requireSession(sessionToken, username);
    if (!session.ok) return { success: false, message: session.message };
    role = session.user.role;
    const sheet = getSheet(SHEET_NAME_REQUESTS);
    const data = sheet.getDataRange().getValues();

    // ค้นหา displayName ของผู้ใช้งานปัจจุบันเพื่อเช็คความเป็นเจ้าของงาน
    const userSheet = getSheet(SHEET_NAME_USERS);
    const userData = userSheet.getDataRange().getValues();
    let userDisplayName = username;
    for (let u = 1; u < userData.length; u++) {
      if (userData[u][0].toString().trim() === username.toString().trim()) {
        userDisplayName = userData[u][2];
        break;
      }
    }

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === id) {
        const reqNo = data[i][1];
        const status = data[i][10];
        const createdBy = data[i][14];

        // 🛡️ เช็คสิทธิ์ความปลอดภัย
        if (role !== ADMIN_ROLE) {
          if (String(createdBy).trim() !== String(userDisplayName).trim() && String(createdBy).trim() !== String(username).trim()) {
            return { success: false, message: "ไม่มีสิทธิ์ลบรายการของผู้อื่น" };
          }
          if (status !== "รอดำเนินการ") {
            return { success: false, message: "ไม่สามารถลบได้ เนื่องจากเจ้าหน้าที่รับเรื่องไปแล้ว" };
          }
        }

        sheet.deleteRow(i + 1);
        writeLog(username, "DELETE", "ลบคำขอ " + reqNo);
        return { success: true };
      }
    }
    return { success: false, message: "ไม่พบรายการ" };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ─── EMAIL ────────────────────────────────────────────────────
function sendReportEmail(payload, username, sessionToken) {
  try {
    const session = requireSession(sessionToken, username, true);
    if (!session.ok) return { success: false, message: session.message };
    const subject = `[HosXP Report] ${payload.requestNo} — ${payload.reportType}`;
    const body = buildEmailBody(payload);

    const options = { name: "ระบบขอรายงาน HosXP" };
    if (payload.cc) options.cc = payload.cc;

    GmailApp.sendEmail(payload.to, subject, "", { ...options, htmlBody: body });
    writeLog(username, "EMAIL", "ส่งอีเมลคำขอ " + payload.requestNo + " ถึง " + payload.to);
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function buildEmailBody(p) {
  return `
  <div style="font-family:Sarabun,sans-serif;max-width:600px;margin:auto;border:1px solid #ddd;border-radius:8px;overflow:hidden">
    <div style="background:#1a73e8;color:#fff;padding:20px 24px">
      <h2 style="margin:0;font-size:18px">🏥 ระบบขอรายงาน HosXP</h2>
      <p style="margin:4px 0 0;font-size:13px;opacity:.85">โรงพยาบาลคลองหาด — แผนก IT</p>
    </div>
    <div style="padding:24px">
      <p>เรียน ผู้รับผิดชอบ,</p>
      <p>มีคำขอรายงานใหม่เข้ามาในระบบ กรุณาตรวจสอบรายละเอียดด้านล่าง:</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr style="background:#f8f9fa"><td style="padding:8px 12px;font-weight:bold;width:40%">เลขที่คำขอ</td><td style="padding:8px 12px">${p.requestNo}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold">ชื่อผู้ขอ</td><td style="padding:8px 12px">${p.requesterName}</td></tr>
        <tr style="background:#f8f9fa"><td style="padding:8px 12px;font-weight:bold">เบอร์โทรภายใน</td><td style="padding:8px 12px">${p.requesterPhone || "-"}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold">แผนก</td><td style="padding:8px 12px">${p.department}</td></tr>
        <tr style="background:#f8f9fa"><td style="padding:8px 12px;font-weight:bold">ประเภทรายงาน / หัวข้อ</td><td style="padding:8px 12px">${p.reportType}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold">ประเภทข้อมูลที่ต้องการ</td><td style="padding:8px 12px">${p.dataType || "-"}</td></tr>
        <tr style="background:#f8f9fa"><td style="padding:8px 12px;font-weight:bold">ช่วงวันที่ข้อมูล</td><td style="padding:8px 12px">${p.dateFrom} ถึง ${p.dateTo}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold">คอลัมน์/Fields ที่ต้องการ</td><td style="padding:8px 12px">${p.requestedFields || "-"}</td></tr>
        <tr style="background:#f8f9fa"><td style="padding:8px 12px;font-weight:bold">เงื่อนไขการกรอง (Filter)</td><td style="padding:8px 12px">${p.filterCondition || "-"}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold">รูปแบบไฟล์</td><td style="padding:8px 12px">${p.fileFormat || "-"}</td></tr>
        <tr style="background:#f8f9fa"><td style="padding:8px 12px;font-weight:bold">วันที่ต้องการรับรายงาน</td><td style="padding:8px 12px">${p.neededDate || "-"}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold">วัตถุประสงค์</td><td style="padding:8px 12px">${p.purpose}</td></tr>
        <tr style="background:#f8f9fa"><td style="padding:8px 12px;font-weight:bold">ความเร่งด่วน</td><td style="padding:8px 12px">${p.urgency}</td></tr>
      </table>
      <div style="margin-top:20px;padding:12px 16px;background:#fff3cd;border-left:4px solid #ffc107;border-radius:4px">
        <strong>หมายเหตุ/ข้อมูลเพิ่มเติม:</strong> ${p.additionalNote || "ไม่มี"}
      </div>
      <div style="margin-top:24px;text-align:center">
        <a href="${WEB_APP_URL}" style="background:#1a73e8;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:bold">เข้าสู่ระบบเพื่อดำเนินการ</a>
      </div>
    </div>
    <div style="background:#f8f9fa;padding:12px 24px;text-align:center;font-size:12px;color:#666">
      อีเมลนี้ส่งจากระบบขอรายงาน HosXP อัตโนมัติ — กรุณาอย่าตอบกลับ
    </div>
  </div>`;
}

// ─── LINE NOTIFICATION ENGINE ────────────────────────────────
function sendLineNotification(targetId, flexContents) {
  if (!LINE_ACCESS_TOKEN || LINE_ACCESS_TOKEN.startsWith("ใส่")) return;

  const url = "https://api.line.me/v2/bot/message/push";
  const payload = {
    "to": targetId,
    "messages": [{
      "type": "flex",
      "altText": "🚨 มีการอัปเดตระบบขอรายงาน HosXP",
      "contents": flexContents
    }]
  };

  const options = {
    "method": "post",
    "headers": {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + LINE_ACCESS_TOKEN
    },
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    writeLog("LINE_SYSTEM", "SEND_NOTIFICATION", response.getContentText());
  } catch (e) {
    writeLog("LINE_SYSTEM", "SEND_ERROR", e.message);
  }
}

// ─── TELEGRAM NOTIFICATION ENGINE ────────────────────────────
function sendTelegramNotification(chatId, message) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return;

  const url = "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage";
  const payload = {
    "chat_id": chatId,
    "text": message,
    "parse_mode": "HTML"
  };

  const options = {
    "method": "post",
    "headers": {
      "Content-Type": "application/json"
    },
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    writeLog("TELEGRAM_SYSTEM", "SEND_NOTIFICATION", response.getContentText());
  } catch (e) {
    writeLog("TELEGRAM_SYSTEM", "SEND_ERROR", e.message);
  }
}

function testTelegramNotification(chatId) {
  try {
    if (!chatId) return { success: false, message: "กรุณาระบุ Telegram Chat ID" };
    sendTelegramNotification(chatId, "🔔 <b>ทดสอบระบบแจ้งเตือน Telegram</b>\n\nการเชื่อมต่อระหว่าง Telegram และระบบขอรายงาน HosXP สำเร็จแล้ว!");
    return { success: true, message: "ส่งข้อความทดสอบเข้า Telegram แล้ว" };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ─── FLEX MESSAGE GENERATORS (UI DESIGN) ──────────────────────

// 1. Flex Message สำหรับคำขอใหม่
function buildNewRequestFlex(p) {
  let urgencyColor = "#2FB67E"; // ปกติ (สีเขียว)
  if (p.urgency === "สูง" || p.urgency === "เร่งด่วน") urgencyColor = "#F3B34C"; // ด่วน (สีส้ม)
  if (p.urgency === "ด่วนที่สุด" || p.urgency === "ด่วนมาก") urgencyColor = "#DE5D4E"; // ด่วนที่สุด (สีแดง)

  return {
    "type": "bubble",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        { "type": "text", "text": "📥 มีคำขอรายงาน HosXP ใหม่", "weight": "bold", "color": "#ffffff", "size": "md" },
        { "type": "text", "text": p.requestNo, "color": "#ffffffcc", "size": "xs", "margin": "xs" }
      ],
      "backgroundColor": "#1A73E8"
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        { "type": "text", "text": p.reportType, "weight": "bold", "size": "lg", "wrap": true },
        {
          "type": "box", "layout": "horizontal", "margin": "md",
          "contents": [
            { "type": "text", "text": "ความเร่งด่วน", "size": "sm", "color": "#aaaaaa" },
            { "type": "text", "text": p.urgency, "size": "sm", "color": urgencyColor, "weight": "bold", "align": "end" }
          ]
        },
        { "type": "separator", "margin": "md" },
        {
          "type": "box", "layout": "vertical", "margin": "md", "spacing": "sm",
          "contents": [
            { "type": "text", "text": `👤 ผู้ขอ: ${p.requesterName} (${p.department})`, "size": "sm", "color": "#555555" },
            { "type": "text", "text": `📞 โทรภายใน: ${p.requesterPhone || "-"}`, "size": "sm", "color": "#555555" },
            { "type": "text", "text": `📅 ช่วงข้อมูล: ${p.dateFrom} ถึง ${p.dateTo}`, "size": "sm", "color": "#555555" },
            { "type": "text", "text": `📂 ประเภทข้อมูล: ${p.dataType || "-"}`, "size": "sm", "color": "#555555", "wrap": true },
            { "type": "text", "text": `💾 รูปแบบไฟล์: ${p.fileFormat || "-"}`, "size": "sm", "color": "#555555" },
            { "type": "text", "text": `🎯 วัตถุประสงค์: ${p.purpose}`, "size": "sm", "color": "#555555", "wrap": true }
          ]
        }
      ]
    },
    "footer": {
      "type": "box", "layout": "vertical",
      "contents": [
        {
          "type": "button",
          "action": { "type": "uri", "label": "เปิดดูระบบ & ดำเนินการ", "uri": WEB_APP_URL },
          "style": "primary", "color": "#1A73E8"
        }
      ]
    }
  };
}

// 2. Flex Message สำหรับอัปเดตสถานะงาน
function buildStatusUpdateFlex(requestNo, reportType, status, adminNote, downloadUrl) {
  let statusColor = "#F3B34C"; // รอดำเนินการ (ส้ม)
  if (status === "กำลังดำเนินการ") statusColor = "#1A73E8"; // ฟ้า
  if (status === "เสร็จสิ้น") statusColor = "#2FB67E"; // เขียว
  if (status === "ปฏิเสธ") statusColor = "#DE5D4E"; // แดง

  const footerContents = [
    {
      "type": "button",
      "action": { "type": "uri", "label": "ตรวจสอบข้อมูลในระบบ", "uri": WEB_APP_URL },
      "style": "secondary"
    }
  ];

  // ถ้างานเสร็จสิ้นและมีลิงก์แนบ ให้เพิ่มปุ่มดาวน์โหลด
  if (status === "เสร็จสิ้น" && downloadUrl) {
    footerContents.push({
      "type": "button",
      "action": { "type": "uri", "label": "💾 ดาวน์โหลดไฟล์รายงาน", "uri": downloadUrl },
      "style": "primary",
      "color": "#10b981",
      "margin": "sm"
    });
  }

  return {
    "type": "bubble",
    "header": {
      "type": "box", "layout": "vertical",
      "contents": [
        { "type": "text", "text": "🔄 อัปเดตสถานะคำขอ", "weight": "bold", "color": "#ffffff", "size": "md" },
        { "type": "text", "text": requestNo, "color": "#ffffffcc", "size": "xs", "margin": "xs" }
      ],
      "backgroundColor": statusColor
    },
    "body": {
      "type": "box", "layout": "vertical",
      "contents": [
        { "type": "text", "text": reportType, "weight": "bold", "size": "md", "wrap": true },
        {
          "type": "box", "layout": "horizontal", "margin": "md",
          "contents": [
            { "type": "text", "text": "สถานะล่าสุด", "size": "sm", "color": "#aaaaaa" },
            { "type": "text", "text": status, "size": "sm", "color": statusColor, "weight": "bold", "align": "end" }
          ]
        },
        { "type": "separator", "margin": "md" },
        {
          "type": "box", "layout": "vertical", "margin": "md",
          "contents": [
            { "type": "text", "text": "📝 หมายเหตุจาก Admin / ไอที:", "size": "xs", "color": "#aaaaaa", "weight": "bold" },
            { "type": "text", "text": adminNote || "ไม่มีหมายเหตุเพิ่มเติม", "size": "sm", "color": "#333333", "margin": "xs", "wrap": true }
          ]
        }
      ]
    },
    "footer": {
      "type": "box", "layout": "vertical",
      "contents": footerContents
    }
  };
}

// ─── DASHBOARD STATS ─────────────────────────────────────────
function getDashboardStats(username, role, displayName, sessionToken) {
  try {
    const session = requireSession(sessionToken, username);
    if (!session.ok) return { success: false, message: session.message };
    role = session.user.role;
    displayName = session.user.displayName;
    ensureHeaders();
    const sheet = getSheet(SHEET_NAME_REQUESTS);
    const data = sheet.getDataRange().getValues();

    const parseData = (val) => (val instanceof Date) ? val.toISOString() : val;

    let rows = data.slice(1).map(row => ({
      id: parseData(row[0]),
      requestNo: parseData(row[1]),
      requesterName: parseData(row[2]),
      department: (row[4] || "").toString().trim(),
      reportType: parseData(row[5]),
      urgency: (row[9] || "").toString().trim(),
      status: (row[10] || "").toString().trim(),
      createdAt: parseData(row[12]),
      createdBy: (row[14] || "").toString().trim(),
      downloadUrl: (row[22] || "").toString().trim()
    }));

    if (role !== ADMIN_ROLE) {
      rows = rows.filter(r => r.createdBy === displayName || r.createdBy === username);
    }

    // Aggregates for Charts
    const deptStats = {};
    const urgencyStats = { "ปกติ": 0, "สูง": 0, "ด่วนที่สุด": 0 };

    rows.forEach(r => {
      const dept = r.department || "ไม่ระบุ";
      deptStats[dept] = (deptStats[dept] || 0) + 1;

      const urg = r.urgency || "ปกติ";
      if (urgencyStats[urg] !== undefined) {
        urgencyStats[urg]++;
      } else {
        urgencyStats[urg] = (urgencyStats[urg] || 0) + 1;
      }
    });

    const topDepts = Object.keys(deptStats)
      .map(name => ({ name, count: deptStats[name] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const stats = {
      total: rows.length,
      pending: rows.filter(r => r.status === "รอดำเนินการ").length,
      processing: rows.filter(r => r.status === "กำลังดำเนินการ").length,
      completed: rows.filter(r => r.status === "เสร็จสิ้น").length,
      rejected: rows.filter(r => r.status === "ปฏิเสธ").length,
      inboxCount: rows.filter(r => r.status === "เสร็จสิ้น" && r.downloadUrl).length,
      recent: rows.slice(-10).reverse(), // ดึงมา 10 รายการเพื่อให้สามารถกรองในหน้าแดชบอร์ดได้ยืดหยุ่นขึ้น
      depts: topDepts,
      urgency: urgencyStats
    };
    return { success: true, data: stats };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ─── UTILITIES ───────────────────────────────────────────────
function generateRequestNo() {
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const sheet = getSheet(SHEET_NAME_REQUESTS);
  const count = Math.max(sheet.getLastRow(), 1);
  const seq = String(count).padStart(4, "0");
  return `REQ${y}${m}${d}-${seq}`;
}

function writeLog(username, action, detail) {
  try {
    const sheet = getSheet(SHEET_NAME_LOGS);
    sheet.appendRow([new Date().toISOString(), username, action, detail]);
  } catch (_) { }
}

function getMonthlyReport(month, year, sessionToken) {
  try {
    const session = requireSession(sessionToken, "", true);
    if (!session.ok) return { success: false, message: session.message };
    ensureHeaders();
    const sheet = getSheet(SHEET_NAME_REQUESTS);
    const data = sheet.getDataRange().getValues();

    const headers = data[0].map(h => h.toString().trim());
    const parseData = (val) => (val instanceof Date) ? val.toISOString() : val;

    const result = data.slice(1).filter(row => {
      const d = new Date(row[12]);
      if (isNaN(d.getTime())) return false;

      return (d.getMonth() + 1).toString() === month.toString() && d.getFullYear().toString() === year.toString();
    }).map(row => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = parseData(row[i]));
      return obj;
    });

    return { success: true, data: result };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ─── PROFILE MANAGEMENT API ───────────────────────────────────
function updateProfile(username, payload, sessionToken) {
  try {
    const session = requireSession(sessionToken, username);
    if (!session.ok) return { success: false, message: session.message };
    const sheet = getSheet(SHEET_NAME_USERS);
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] && data[i][0].toString().trim() === username.toString().trim()) {
        const row = i + 1;

        // อัปเดตข้อมูลทีละฟิลด์ตามที่มีส่งมา
        if (payload.password && payload.password.trim() !== "" && payload.password !== "_LEAVE_UNCHANGED_") {
          sheet.getRange(row, 2).setValue(hashPassword(payload.password.trim()));
        }
        if (payload.displayName) sheet.getRange(row, 3).setValue(payload.displayName);
        if (payload.email) sheet.getRange(row, 4).setValue(payload.email);
        if (payload.department) sheet.getRange(row, 6).setValue(payload.department);

        sheet.getRange(row, 7).setValue(payload.lineId ? payload.lineId.trim() : "");
        sheet.getRange(row, 8).setValue(payload.telegramId ? payload.telegramId.trim() : "");

        writeLog(username, "PROFILE_UPDATE", "อัปเดตข้อมูลส่วนตัวและช่องทางการแจ้งเตือน");
        return { success: true };
      }
    }
    return { success: false, message: "ไม่พบผู้ใช้ที่ต้องการแก้ไข" };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ─── GEMINI AI INTEGRATION ────────────────────────────────────

/**
 * เรียกใช้งาน Gemini 1.5 Flash API ผ่าน Google AI Studio
 */
function callGeminiAPI(prompt, systemInstruction, history = []) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey || apiKey.trim() === "" || apiKey.startsWith("ใส่")) {
    Logger.log("Gemini API Key is not set or invalid. Using offline fallback.");
    return null;
  }

  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + apiKey;

  // จัดรูปแบบประวัติการแชท (Gemini API format)
  let contents = [];
  if (history && history.length > 0) {
    history.forEach(msg => {
      let role = msg.role;
      // ปรับจูน Role ให้ถูกต้องตามข้อกำหนดของ Gemini API (ต้องมีแค่ user หรือ model)
      if (role === "admin" || role === "doctor" || role === "user") {
        role = "user";
      }
      contents.push({
        role: role,
        parts: [{ text: msg.text }]
      });
    });
  }

  // แทรกล่าสุดของผู้ส่ง
  contents.push({
    role: "user",
    parts: [{ text: prompt }]
  });

  const payload = {
    contents: contents,
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    generationConfig: {
      temperature: 0.2
    }
  };

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();

    if (responseCode === 200) {
      const resJson = JSON.parse(responseText);
      if (resJson.candidates && resJson.candidates[0].content && resJson.candidates[0].content.parts && resJson.candidates[0].content.parts[0].text) {
        return resJson.candidates[0].content.parts[0].text;
      }
    } else {
      Logger.log(`Gemini API Error: Code ${responseCode} | Details: ${responseText}`);
      writeLog("SYSTEM", "GEMINI_API_ERROR", `HTTP Code: ${responseCode}`);
    }
  } catch (err) {
    Logger.log("Gemini API Exception: " + err.message);
    writeLog("SYSTEM", "GEMINI_API_EXCEPTION", err.message);
  }
  return null; // สลับไปใช้ออฟไลน์ fallback
}

/**
 * วิเคราะห์ความต้องการคำขอรายงานข้อมูลและแนะนำตรรกะ SQL (HOSxP MySQL) ผ่าน AI พร้อมระบบ Fallback
 */
function askGeminiToAnalyzeRequest(requestId, sessionToken) {
  try {
    const session = requireSession(sessionToken, "", true);
    if (!session.ok) return { success: false, message: session.message };
    ensureHeaders();
    const sheet = getSheet(SHEET_NAME_REQUESTS);
    const data = sheet.getDataRange().getValues();
    let row = null;
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === requestId) {
        row = data[i];
        break;
      }
    }

    if (!row) return { success: false, message: "ไม่พบข้อมูลคำขอรายงานในระบบ" };

    const userPrompt = `กรุณาวิเคราะห์คำขอรายงานข้อมูลโรงพยาบาล HOSxP ต่อไปนี้:\n` +
      `- **เลขที่คำขอ**: ${row[1]}\n` +
      `- **ชื่อรายงาน**: ${row[5]}\n` +
      `- **แผนกผู้ขอ**: ${row[4]}\n` +
      `- **ประเภทข้อมูล**: ${row[16] || ""}\n` +
      `- **วัตถุประสงค์**: ${row[8]}\n` +
      `- **คอลัมน์/ข้อมูลที่ต้องการ**: ${row[17] || ""}\n` +
      `- **เงื่อนไขตัวกรอง (Filter)**: ${row[18] || ""}\n` +
      `- **ช่วงเวลาข้อมูล**: ${row[6] ? new Date(row[6]).toLocaleDateString("th-TH") : "-"} ถึง ${row[7] ? new Date(row[7]).toLocaleDateString("th-TH") : "-"}\n` +
      `- **รูปแบบไฟล์**: ${row[19] || ""}\n` +
      `- **หมายเหตุเพิ่มเติม**: ${row[21] || ""}`;

    const systemInstruction = `คุณคือผู้เชี่ยวชาญด้านคลังข้อมูลสุขภาพและฐานข้อมูล HosXP (MySQL/MariaDB) และนักวิเคราะห์ข้อมูลโรงพยาบาลอาวุโส (Senior Medical Information Officer)
หน้าที่ของคุณคือรับข้อมูลคำขอรายงานจากผู้ใช้ แล้วทำการวิเคราะห์โครงสร้างข้อมูลและสร้างคำสั่ง SQL สำหรับฐานข้อมูล HosXP

กรุณาวิเคราะห์และจัดทำข้อเสนอรายงานเป็นภาษาไทย โดยแบ่งออกเป็นหัวข้อดังนี้:
1. ชื่อรายงานและวัตถุประสงค์ (Report Name & Objective): สรุปประเภทรายงานและวัตถุประสงค์สั้นๆ
2. ข้อมูลที่ต้องแสดงในรายงาน (Output Columns): ตารางแสดงลำดับ, ชื่อคอลัมน์ภาษาไทย, ฟิล์ดและตารางอ้างอิง, และหมายเหตุ
3. เงื่อนไขและตัวกรอง (Filters & Criteria): เงื่อนไขในการดึงข้อมูลตามคำขอ
4. ตารางหลักของ HosXP ที่เกี่ยวข้อง (Related HosXP Tables): รายชื่อตารางที่ต้องใช้
5. ร่างคำสั่ง SQL (Draft SQL Query): เขียนคำสั่ง MySQL ที่ถูกต้อง มีประสิทธิภาพ และพร้อมใช้งาน (ครอบโค้ดด้วย \`\`\`sql ... \`\`\`)
6. ข้อแนะนำและข้อจำกัดทางเทคนิค (Suggestions & Technical Notes)

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
5. ความปลอดภัย: หากข้อมูลในคำขอไม่ชัดเจน ให้เขียน SQL ที่ปลอดภัยและสมเหตุสมผลที่สุด พร้อมคอมเมนต์บอกข้อจำกัดไว้ในโค้ด`;

    // 1. เรียกใช้งาน Gemini API จริงก่อน
    const realAiText = callGeminiAPI(userPrompt, systemInstruction);
    if (realAiText) {
      return { success: true, analysis: realAiText };
    }

    // 2. หากพลาด ให้เปลี่ยนมาใช้ระบบ Offline Rule Engine (Fallback)
    const aiResult = getAIResponseWithFallback(userPrompt, systemInstruction);
    if (!aiResult.success) return aiResult;

    return { success: true, analysis: aiResult.text };
  } catch (e) {
    return { success: false, message: "เกิดข้อผิดพลาดของระบบ: " + e.message };
  }
}

/**
 * คุยกับ Chatbot แบบโต้ตอบผ่าน AI พร้อมระบบ Fallback
 */
function askGeminiChat(history, role, sessionToken) {
  try {
    const session = requireSession(sessionToken);
    if (!session.ok) return { success: false, message: session.message };
    role = session.user.role;
    let systemInstruction = "";
    if (role === ADMIN_ROLE) {
      let recentApprovedContext = "";
      try {
        const sheet = getSheet(SHEET_NAME_REQUESTS);
        const data = sheet.getDataRange().getValues();
        const completedRequests = [];
        for (let i = data.length - 1; i >= 1; i--) {
          const row = data[i];
          if (row[10] === "เสร็จสิ้น" && row[11]) { // status = เสร็จสิ้น และมี adminNote
            const sql = extractSqlFromNote_(row[11]);
            if (sql) {
              completedRequests.push({
                reportType: row[5],
                purpose: row[8],
                sql: sql
              });
            }
            if (completedRequests.length >= 6) break; // ดึงมาสูงสุด 6 รายการ
          }
        }
        if (completedRequests.length > 0) {
          recentApprovedContext = "\n\n### ตัวอย่างคำขอรายงานที่ทำเสร็จแล้วล่าสุด (ใช้อ้างอิงเป็นตัวอย่างการสร้างตารางและเขียน SQL):\n" +
            completedRequests.map(r => `• รายงาน: ${r.reportType}\n  วัตถุประสงค์: ${r.purpose}\n  คำสั่ง SQL:\n  \`\`\`sql\n${r.sql}\n  \`\`\``).join("\n\n");
        }
      } catch (err) {
        Logger.log("ไม่สามารถดึงข้อมูลรายงานย้อนหลังเป็นบริบทได้: " + err.message);
      }

      systemInstruction = `คุณคือ AI ผู้ช่วยอัจฉริยะสำหรับ IT ในการวิเคราะห์ตารางและเขียน SQL HOSxP (MySQL/MariaDB)
ทุกครั้งที่ให้ SQL ต้องครอบด้วย markdown code block (\`\`\`sql ... \`\`\`) และอธิบายเหตุผลสั้นๆ

### ตาราง HosXP สำหรับเชื่อมโยง (Database Schema Context):
- patient: hn, fname, lname, sex, birthday, cid
- ovst: vn, hn, vstdate, vsttime, spclty, pttype, main_dep
- vn_stat: vn, hn, pdx, dx0, dx1, dx2, dx3, age_y, pttype, uc_money
- ovstdiag: vn, hn, icd10, diagtype (1=Primary, 2=Secondary)
- ipt: an, hn, regdate, dchdate, ward, spclty, pttype
- an_stat: an, hn, pdx, age_y, pttype
- iptdiag: an, hn, icd10, diagtype
- opitemrece: vn, an, hn, rxdate, icode, qty, sum_price
- drugitems: icode, name, strength, units
- nondrugitems: icode, name
- pttype: pttype, name
- doctor: code, name
- ward: ward, name
- spclty: spclty, name
- icd101: code, name

### กฎสำคัญ:
1. ดึงสิทธิ์คนไข้ หรือตึก ให้ LEFT JOIN ตาราง pttype หรือ ward เสมอ
2. เชื่อมโยงธุรกรรมการเงิน/ยา (opitemrece) ของผู้ป่วยนอก (OPD) ใช้ vn ส่วนผู้ป่วยใน (IPD) ใช้ an เสมอ เพื่อป้องกันข้อมูลซ้ำซ้อน
3. การกรองวันที่ ให้ระบุ Placeholder เป็น :start_date และ :end_date เพื่อความยืดหยุ่นในการดึงรายงาน${recentApprovedContext}`;
    } else {
      let popularReports = "";
      try {
        const sheet = getSheet(SHEET_NAME_REQUESTS);
        const data = sheet.getDataRange().getValues();
        const counts = {};
        for (let i = 1; i < data.length; i++) {
          const type = data[i][5];
          if (type) counts[type] = (counts[type] || 0) + 1;
        }
        const topTypes = Object.keys(counts).sort((a,b) => counts[b] - counts[a]).slice(0, 5);
        if (topTypes.length > 0) {
          popularReports = "\n\n### รายงานยอดนิยมที่มีเพื่อนร่วมงานของคุณขอเข้ามาบ่อยที่สุดล่าสุด:\n" + 
            topTypes.map((t, idx) => `• ${t} (ขอแล้ว ${counts[t]} ครั้ง)`).join("\n");
        }
      } catch (err) {
        Logger.log("ไม่สามารถดึงความนิยมรายงานได้: " + err.message);
      }

      systemInstruction = "คุณคือ AI ผู้ช่วยอัจฉริยะสำหรับบุคลากรทางการแพทย์ในระบบขอรายงาน HosXP\n" +
        "ห้ามแสดง SQL หรือชื่อตารางเชิงเทคนิคให้ผู้ใช้เห็นเด็ดขาด ให้แนะนำวิธีอธิบายรายงานที่ดีและแนะนำการกรอกแบบฟอร์มขอรายงานแทน" + popularReports;
    }

    const lastMessage = history[history.length - 1].text;
    const historySlice = history.slice(0, -1);

    // 1. เรียกใช้งาน Gemini API จริงก่อน
    const realAiResponse = callGeminiAPI(lastMessage, systemInstruction, historySlice);
    if (realAiResponse) {
      return { success: true, response: realAiResponse };
    }

    // 2. หากพลาด ให้เปลี่ยนมาใช้ระบบ Offline Rule Engine (Fallback)
    const lastMessageFallback = history.pop().text;
    const aiResult = getAIResponseWithFallback(lastMessageFallback, systemInstruction, history);
    
    if (!aiResult.success) return aiResult;
    return { success: true, response: aiResult.text };
  } catch (e) {
    return { success: false, message: "เกิดข้อผิดพลาดในการประมวลผลแชท: " + e.message };
  }
}

function extractSqlFromNote_(note) {
  if (!note) return "";
  const match = note.match(/SELECT[\s\S]+?;/i) || note.match(/SELECT[\s\S]+/i);
  return match ? match[0].trim() : note.trim();
}

// ─── UPLOAD FILE TO DRIVE ───────────────────────────────────────
function uploadFileToDrive(base64Data, fileName, mimeType, sessionToken) {
  try {
    const session = requireSession(sessionToken, "", true);
    if (!session.ok) return { success: false, message: session.message };
    return uploadFileToDrive_(base64Data, fileName, mimeType);
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ฟังก์ชันภายใน: ใช้จาก doPost หลังตรวจ API token แล้วเท่านั้น
function uploadFileToDrive_(base64Data, fileName, mimeType, requestId) {
  try {
    if (!base64Data || !fileName) return { success: false, message: "ไม่พบข้อมูลไฟล์" };
    const safeFileName = String(fileName).replace(/[^a-zA-Z0-9._()\-ก-๙ ]/g, "_").slice(0, 150);
    const maxBytes = 20 * 1024 * 1024;
    // กำหนด MIME Type ตามนามสกุลไฟล์ หาก client ส่งค่าว่างมา หรือเป็นค่าเริ่มต้นที่ไม่สมบูรณ์
    if (!mimeType || mimeType === "") {
      const ext = fileName.split('.').pop().toLowerCase();
      const mimeTypes = {
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'xls': 'application/vnd.ms-excel',
        'csv': 'text/csv',
        'pdf': 'application/pdf',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'zip': 'application/zip',
        'txt': 'text/plain'
      };
      mimeType = mimeTypes[ext] || 'application/octet-stream';
    }

    const byteCharacters = Utilities.base64Decode(base64Data);
    if (byteCharacters.length > maxBytes) return { success: false, message: "ไฟล์มีขนาดเกิน 20 MB" };
    const blob = Utilities.newBlob(byteCharacters, mimeType, safeFileName);
    
    // ค้นหาหรือสร้างโฟลเดอร์สำหรับเก็บรายงาน
    const folderName = "HosXP_Completed_Reports";
    let folder;
    const folders = DriveApp.getFoldersByName(folderName);
    if (folders.hasNext()) {
      folder = folders.next();
    } else {
      folder = DriveApp.createFolder(folderName);
    }
    
    const file = folder.createFile(blob);
    
    let shared = false;
    if (requestId) {
      try {
        const sheet = getSheet(SHEET_NAME_REQUESTS);
        const data = sheet.getDataRange().getValues();
        for (let i = 1; i < data.length; i++) {
          if (data[i][0] === requestId) {
            const email = data[i][3]; // requesterEmail
            if (email && email.includes("@")) {
              file.addViewer(email.trim());
              shared = true;
            }
            break;
          }
        }
      } catch (err) {
        writeLog("SYSTEM_ERROR", "SHARE_FILE_ERROR", err.message);
      }
    }

    if (!shared) {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      writeLog("SECURITY_WARNING", "FILE_SHARED_PUBLICLY", `ไฟล์ถูกแชร์สาธารณะเนื่องจากไม่พบอีเมลผู้ขอ: ${safeFileName}`);
    } else {
      writeLog("SYSTEM", "FILE_SHARED_SECURELY", `แชร์ไฟล์แบบปลอดภัยให้กับผู้ขอเรียบร้อยแล้ว: ${safeFileName}`);
    }
    
    return {
      success: true,
      url: file.getUrl(), // ใช้ URL หน้าตัวอย่างแสดงผลที่เปิดดูและดาวน์โหลดได้ง่าย
      downloadUrl: file.getDownloadUrl()
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/**
 * ย้ายข้อมูลคำขอรายงานที่ทำเสร็จสิ้นหรือถูกปฏิเสธ (ที่มีอายุเกิน 90 วัน) ไปเก็บในแผ่นงาน Archive
 */
function archiveOldRequests() {
  try {
    const activeSheet = getSheet(SHEET_NAME_REQUESTS);
    const data = activeSheet.getDataRange().getValues();
    if (data.length <= 1) {
      return { success: true, archivedCount: 0, message: "ไม่มีข้อมูลคำขอให้ประมวลผล" };
    }
    
    const headers = data[0];
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);
    
    const eligibleRows = []; // To hold row numbers and values: { rowNum, values }
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const status = (row[10] || "").toString().trim();
      const updatedAtStr = row[13];
      
      if (status === "เสร็จสิ้น" || status === "ปฏิเสธ") {
        const updatedAt = new Date(updatedAtStr);
        if (!isNaN(updatedAt.getTime()) && updatedAt < cutoffDate) {
          eligibleRows.push({
            rowNum: i + 1, // 1-indexed row number in sheet
            values: row
          });
        }
      }
    }
    
    if (eligibleRows.length === 0) {
      return { success: true, archivedCount: 0, message: "ไม่พบคำขอเก่าที่ตรงตามเงื่อนไขย้ายประวัติ (เสร็จสิ้น/ปฏิเสธ เกิน 90 วัน)" };
    }
    
    // Open or create Archive sheet
    const archiveSheet = getSheet("Archive_Requests");
    if (archiveSheet.getLastRow() === 0) {
      archiveSheet.appendRow(headers);
      archiveSheet.getRange(1, 1, 1, headers.length)
        .setFontWeight("bold")
        .setBackground("#5f6368")
        .setFontColor("#ffffff");
    }
    
    // Append eligible rows to Archive sheet
    const valuesToAppend = eligibleRows.map(r => r.values);
    archiveSheet.getRange(archiveSheet.getLastRow() + 1, 1, valuesToAppend.length, headers.length)
      .setValues(valuesToAppend);
    
    // Delete rows from the active sheet in reverse order to prevent shifting
    for (let j = eligibleRows.length - 1; j >= 0; j--) {
      activeSheet.deleteRow(eligibleRows[j].rowNum);
    }
    
    writeLog("SYSTEM", "ARCHIVE_OLD_REQUESTS", `ย้ายประวัติคำขอเก่าสำเร็จ ${eligibleRows.length} รายการ ไปยัง Archive_Requests`);
    return { success: true, archivedCount: eligibleRows.length, message: `ย้ายข้อมูลเก่าเรียบร้อยแล้วจำนวน ${eligibleRows.length} รายการ` };
  } catch (e) {
    writeLog("SYSTEM_ERROR", "ARCHIVE_ERROR", e.message);
    return { success: false, message: "เกิดข้อผิดพลาดในการย้ายข้อมูล: " + e.message };
  }
}
