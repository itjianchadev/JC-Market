const TOKEN_KEY = 'jcsm_token';
const USER_KEY = 'jcsm_user';
const LANG_KEY = 'jcsm_lang';

function getToken(){return localStorage.getItem(TOKEN_KEY)}
function getUser(){try{return JSON.parse(localStorage.getItem(USER_KEY))}catch{return null}}
function setAuth(t,u){localStorage.setItem(TOKEN_KEY,t);localStorage.setItem(USER_KEY,JSON.stringify(u))}
function clearAuth(){localStorage.removeItem(TOKEN_KEY);localStorage.removeItem(USER_KEY);location.href='/login.html'}
function requireLogin(){if(!getToken()){location.href='/login.html';return false}return true}
function denyFinance(){const u=getUser();if(u&&u.role==='finance'){location.href='/approvals.html?tab=pending';return false}return true}

/* ─────────────── i18n ─────────────── */
const I18N = {
  th: {
    // Nav
    'nav.shop':'🛒 ร้านค้า','nav.cart':'🧺 ตะกร้า','nav.orders':'📋 คำสั่งซื้อ',
    'nav.stock':'📊 Stock','nav.admin':'⚙️ Admin','nav.logout':'ออกจากระบบ',
    'nav.team':'👥 จัดการผู้ใช้',
    'nav.pending_approvals':'⏳ รายการต้องอนุมัติ','nav.approved_list':'✅ รายการที่อนุมัติแล้ว','nav.rejected_list':'❌ ปฏิเสธ',
    // Common
    'common.loading':'กำลังโหลด...','common.close':'ปิด','common.confirm':'ยืนยัน','common.cancel':'ยกเลิก',
    'common.search':'ค้นหา','common.note':'หมายเหตุ','common.no_data':'ยังไม่มีข้อมูล','common.all':'ทั้งหมด',
    'common.qty':'จำนวน','common.item':'สินค้า','common.code':'รหัส','common.price':'ราคา','common.unit':'หน่วย',
    'common.total':'รวม','common.category':'หมวด','common.save':'บันทึก','common.delete':'ลบ',
    'common.branch':'สาขา','common.date':'วันที่','common.status':'สถานะ','common.amount':'ยอด',
    // Login
    'login.title':'🛍️ JC-Market','login.sub':'ระบบสั่งซื้อวัตถุดิบสำหรับสาขา FC',
    'login.username':'Username','login.password':'Password','login.submit':'เข้าสู่ระบบ',
    'login.page_title':'เข้าสู่ระบบ — JC-Market',
    // Shop (index)
    'shop.page_title':'ร้านค้า — JC-Market',
    'shop.categories':'หมวดหมู่','shop.search_placeholder':'ค้นหาสินค้า...',
    'shop.group_general':'สินค้าทั่วไป','shop.group_fruit':'ผลไม้สด',
    'shop.overdue_credit':'มีออร์เดอร์เครดิตเกินกำหนดค้าง {n} รายการ — สั่งผลไม้สดใหม่ไม่ได้จนกว่าจะชำระครบ (สั่งสินค้าทั่วไปได้ปกติ)',
    'shop.col.code':'รหัส','shop.col.name':'ชื่อสินค้า','shop.col.price':'ราคา',
    'shop.col.stock':'คงเหลือ','shop.col.uom':'หน่วย','shop.col.action':'สั่งซื้อ',
    'shop.showing':'แสดง {n} รายการ','shop.showing_cat':'แสดง {n} รายการ ในหมวด {cat}',
    'shop.no_items':'ไม่พบสินค้า','shop.out_of_stock':'หมด','shop.btn_order':'+ สั่ง',
    'shop.hide_oos':'ซ่อนสินค้าหมด','shop.oos_hidden':'ซ่อน {n} ที่หมด',
    'shop.oos_alert':'⚠️ สินค้าหมด ไม่สามารถสั่งซื้อได้',
    'shop.no_price':'ติดต่อ HQ','shop.no_price_btn':'ติดต่อ HQ','shop.no_price_alert':'⚠️ รายการนี้ยังไม่มีราคา — กรุณาติดต่อ HQ',
    'shop.modal.add':'เพิ่มลงตะกร้า','shop.modal.remaining':'คงเหลือ {n} {uom}',
    'shop.added':'เพิ่ม {name} x{qty} ลงตะกร้าแล้ว',
    'shop.others':'อื่นๆ',
    // Cart
    'cart.page_title':'ตะกร้า — JC-Market','cart.title':'ตะกร้าสินค้า',
    'cart.empty':'ตะกร้าว่าง','cart.choose':'เลือกสินค้า','cart.choose_more':'เลือกเพิ่ม',
    'cart.col.item':'สินค้า','cart.col.price_unit':'ราคา/หน่วย','cart.col.qty':'จำนวน',
    'cart.col.uom':'หน่วย','cart.col.total':'รวม',
    'cart.remaining':'คงเหลือ','cart.clear':'ล้างตะกร้า','cart.checkout':'ดำเนินการชำระเงิน',
    'cart.items_count':'{n} รายการ','cart.vat_note':'ยังไม่รวม VAT (คำนวณเมื่อยืนยันสั่งซื้อ)',
    'cart.group_locked':'หมวด {grp} · ห้ามสั่งร่วมกับหมวดอื่นในออร์เดอร์เดียวกัน',
    'cart.removed':'ลบรายการแล้ว','cart.confirm_clear':'ล้างตะกร้าทั้งหมด?',
    // Checkout
    'checkout.page_title':'ชำระเงิน — JC-Market',
    'checkout.confirm':'ยืนยันคำสั่งซื้อ','checkout.items':'รายการสินค้า',
    'checkout.note_label':'หมายเหตุ (ถ้ามี)','checkout.note_placeholder':'ระบุหมายเหตุเพิ่มเติม...',
    'checkout.summary':'สรุปคำสั่งซื้อ','checkout.subtotal':'ยอดรวมสินค้า','checkout.grand':'รวม',
    'checkout.vat_note':'VAT คำนวณจาก D365 BC เมื่อยืนยันสั่งซื้อ','checkout.place':'ยืนยันสั่งซื้อ',
    'checkout.pay':'ชำระเงิน','checkout.pay_expired':'⏰ หมดเวลาชำระเงิน',
    'checkout.pay_timeout_sub':'กรุณาชำระเงินภายในเวลาที่กำหนด มิฉะนั้นระบบจะยกเลิกคำสั่งซื้ออัตโนมัติ',
    'checkout.pay_cancelled_sub':'คำสั่งซื้อถูกยกเลิกอัตโนมัติ กำลังนำท่านกลับ...',
    'checkout.step1_done':'สร้างคำสั่งซื้อ {no} สำเร็จ','checkout.step2':'สแกน QR PromptPay ชำระเงิน',
    'checkout.step3':'อัพโหลดสลิปการโอน','checkout.upload_slip':'อัพโหลดสลิป',
    'checkout.upload_hint':'คลิกหรือลากไฟล์สลิปมาวางที่นี่',
    'checkout.upload_types':'รองรับ JPG, PNG, PDF (สูงสุด 10MB)',
    'checkout.upload_btn':'ส่งสลิป','checkout.uploading':'กำลังอัพโหลด...',
    'checkout.qr_title':'PromptPay QR','checkout.qr_hint':'สแกน QR ด้วยแอปธนาคาร',
    'checkout.vat_breakdown':'สินค้า ฿{sub} + VAT ฿{vat}',
    'checkout.bc_po':'BC Purchase Order','checkout.bc_so':'BC Sales Order',
    'checkout.order_no_label':'คำสั่งซื้อ',
    'checkout.pending_title':'ส่งสลิปแล้ว — รอ Finance ตรวจสอบ',
    'checkout.pending_msg':'คำสั่งซื้อนี้จะสำเร็จเมื่อ Finance ตรวจสอบแล้วเท่านั้น',
    'checkout.payment_method':'วิธีชำระเงิน',
    'checkout.pay_immediate':'ชำระทันที (โอนพร้อมส่งสลิป)',
    'checkout.pay_credit_7d':'เครดิต 7 วัน (ชำระภายใน 7 วันหลังสั่ง)',
    'checkout.credit_title':'รับออร์เดอร์เครดิต 7 วัน',
    'checkout.credit_msg':'กำหนดชำระเงินภายใน {due} · เมื่อโอนแล้วอัปสลิปได้ที่หน้าคำสั่งซื้อ',
    'checkout.credit_overdue':'⚠ เกินกำหนดชำระ (เครดิต 7 วัน)',
    'checkout.credit_overdue_sub':'ยังสามารถอัปสลิปได้ · สาขานี้จะสั่งผลไม้สดใหม่ไม่ได้จนกว่าจะชำระค้างหมด',
    'checkout.transfer_amount':'ยอดโอน','checkout.sender':'ผู้โอน','checkout.receiver':'ผู้รับ',
    'checkout.ref':'Ref',
    'checkout.auto_pass_hint':'✓ ตรวจสลิปอัตโนมัติผ่าน — รอ Finance อนุมัติ',
    'checkout.auto_fail_hint':'⚠ ตรวจสลิปอัตโนมัติไม่ผ่าน:',
    'checkout.view_orders':'ดูคำสั่งซื้อ','checkout.back_shop':'กลับหน้าร้านค้า',
    'checkout.save_qr':'💾 บันทึก QR','checkout.download_pdf':'📄 ดาวน์โหลด PDF',
    'checkout.pdf_title':'คำสั่งซื้อ / Order','checkout.pdf_order_no':'เลขที่คำสั่งซื้อ',
    'checkout.pdf_date':'วันที่','checkout.pdf_branch':'สาขา',
    'checkout.pdf_items':'รายการสินค้า','checkout.pdf_subtotal':'ยอดสินค้า',
    'checkout.pdf_vat':'VAT','checkout.pdf_total':'รวมชำระ',
    'checkout.pdf_scan':'สแกน QR PromptPay ชำระเงิน','checkout.pdf_print':'🖨️ พิมพ์ / Save as PDF',
    // Orders
    'orders.page_title':'คำสั่งซื้อ — JC-Market','orders.title':'คำสั่งซื้อ',
    'orders.empty':'ยังไม่มีคำสั่งซื้อ',
    'orders.status.pending':'รอชำระเงิน','orders.status.paid':'ส่งสลิปแล้ว',
    'orders.status.verified':'อนุมัติแล้ว','orders.status.failed':'ปฏิเสธ','orders.status.cancelled':'ยกเลิก',
    'orders.fulfill.pending':'รอจัดส่ง','orders.fulfill.shipped':'จัดส่งแล้ว',
    'orders.fulfill.partial':'รับบางส่วน','orders.fulfill.received':'รับครบแล้ว',
    'orders.items':'รายการสินค้า','orders.subtotal':'ยอดสินค้า','orders.vat':'VAT','orders.grand':'รวมทั้งสิ้น',
    'orders.note_prefix':'หมายเหตุ: {note}','orders.pay':'ชำระเงิน',
    'orders.pay_hint':'กรุณาชำระเงินภายในเวลาที่กำหนด',
    'orders.credit_due':'เครดิต 7 วัน · กำหนดชำระภายใน',
    'orders.credit_overdue':'เกินกำหนดชำระ (เครดิต 7 วัน)',
    'orders.scan_qr':'สแกน QR ด้วยแอปธนาคาร','orders.upload_click':'คลิกเพื่ออัพโหลดสลิป',
    'orders.upload_types':'รองรับ JPG, PNG, PDF','orders.send_slip':'ส่งสลิป',
    'orders.uploading':'กำลังอัพโหลด...','orders.cancel_order':'✕ ยกเลิกคำสั่งซื้อ',
    'orders.cancel_reason_prompt':'กรุณาระบุเหตุผลในการยกเลิก:',
    'orders.cancel_default_reason':'ยกเลิกโดยผู้ใช้',
    'orders.cancelled_title':'คำสั่งซื้อถูกยกเลิก','orders.pay_timeout':'หมดเวลาชำระเงิน กำลังยกเลิกอัตโนมัติ...',
    'orders.reorder':'🔄 สั่งซื้ออีกครั้งจากรายการนี้','orders.reorder_confirm':'ต้องการสั่งซื้ออีกครั้งจากรายการนี้?',
    'orders.reorder_loading':'กำลังสร้างคำสั่งซื้อใหม่...',
    'orders.slip':'สลิปการโอน','orders.verified_at':'ตรวจสอบแล้ว {at}',
    'orders.admin.verify':'ตรวจสอบการชำระเงิน','orders.admin.approve':'อนุมัติ','orders.admin.reject':'ปฏิเสธ',
    'orders.fulfill_title':'การจัดส่ง / รับของ','orders.wait_hq':'รอจัดส่งจาก HQ (BC Post PO Receive)',
    'orders.check_bc':'🔄 ตรวจสอบจาก BC','orders.receive':'📦 รับของเข้าสาขา',
    'orders.received_ok':'รับของครบแล้ว','orders.history':'ประวัติรับของ','orders.received_by':'รับโดย',
    'orders.rcv.item':'สินค้า','orders.rcv.order':'สั่ง','orders.rcv.bc_recv':'BC รับ',
    'orders.rcv.fc_rcv':'FC รับแล้ว','orders.rcv.this_time':'รับครั้งนี้',
    'orders.rcv.confirm':'✅ ยืนยันรับของ','orders.rcv.note_placeholder':'หมายเหตุ (ถ้ามี)',
    'orders.rcv.no_items':'ไม่มีรายการรับของ',
    'orders.bc.po':'BC Purchase Order','orders.bc.so':'BC Sales Order','orders.bc.invoice':'BC Invoice',
    'orders.bc.posted':'(Posted)',
    'orders.view_receipt':'🧾 ดูใบเสร็จรับเงิน',
    'orders.gr.title':'รับของสำเร็จ','orders.gr.doc':'ใบรับของ (GR)','orders.gr.order':'คำสั่งซื้อ',
    'orders.gr.date':'วันที่รับ','orders.gr.back':'กลับดูคำสั่งซื้อ','orders.gr.stock':'ดู Stock สาขา',
    'orders.gr.load_err':'สร้าง GR สำเร็จ แต่โหลดเอกสารไม่ได้: {err}',
    'orders.receipt.title':'ใบเสร็จรับเงิน','orders.receipt.subtitle':'Receipt / Tax Invoice',
    'orders.receipt.seller':'ผู้ขาย','orders.receipt.issue_date':'วันที่ออกใบเสร็จ',
    'orders.receipt.buyer':'ผู้ซื้อ / สาขา','orders.receipt.order_no':'เลขที่คำสั่งซื้อ',
    'orders.receipt.no':'#','orders.receipt.code':'รหัส','orders.receipt.item':'รายการ',
    'orders.receipt.qty':'จำนวน','orders.receipt.price':'ราคา/หน่วย','orders.receipt.line_total':'รวม',
    'orders.receipt.subtotal':'ยอดสินค้า','orders.receipt.vat':'VAT (7%)','orders.receipt.grand':'รวมทั้งสิ้น',
    'orders.receipt.paid':'ชำระเงินเรียบร้อย','orders.receipt.via':'ช่องทาง: PromptPay | วันที่ชำระ: {d}',
    'orders.receipt.issued_by':'ผู้อนุมัติ: {name}','orders.receipt.print':'🖨️ พิมพ์ใบเสร็จ',
    'orders.receipt.print_btn':'🖨️ พิมพ์',
    'orders.receipt.not_found':'ยังไม่มีใบเสร็จสำหรับคำสั่งซื้อนี้',
    'orders.receipt.load_err':'โหลดใบเสร็จไม่สำเร็จ: {err}',
    'orders.expired':'⏰ หมดเวลา',
    'orders.pending_review':'ส่งสลิปแล้ว รอ Finance ตรวจสอบ',
    'orders.reject_title':'❌ สลิปถูกปฏิเสธ',
    'orders.rejected_at':'เมื่อ','orders.rejected_by':'โดย',
    'orders.retry_count':'อัปโหลดใหม่ครั้งที่ {n}',
    'orders.reupload_title':'📤 อัปโหลดสลิปใหม่',
    'orders.checking_bc':'กำลังตรวจสอบจาก BC...','orders.bc_shipped':'พบการจัดส่งจาก BC! สถานะอัพเดทแล้ว',
    'orders.bc_checked':'ตรวจสอบแล้ว','orders.bc_not_found':'ยังไม่พบการจัดส่งจาก BC',
    'orders.bc_synced':'ตรวจสอบแล้ว {n} รายการ',
    // Stock balance
    'stock.page_title':'Stock สาขา — JC-Market','stock.title':'Stock สาขา',
    'stock.items':'รายการสินค้าในคลัง','stock.gr_history':'ประวัติการรับสินค้า',
    'stock.gr_history_full':'ประวัติการรับสินค้า (GR)',
    'stock.issue_history':'ประวัติการเบิกสินค้า',
    'stock.search':'ค้นหาสินค้า...','stock.col.code':'รหัส','stock.col.item':'สินค้า',
    'stock.col.received':'จำนวนรับ','stock.col.uom':'หน่วย','stock.col.category':'หมวด',
    'stock.col.issued':'เบิก','stock.col.onhand':'สต๊อกคงเหลือ',
    'stock.empty':'ยังไม่มีข้อมูล Stock — จะอัพเดทเมื่อรับของเข้าสาขา',
    'stock.summary.items':'รายการสินค้า','stock.summary.qty':'จำนวนรับทั้งหมด','stock.summary.cats':'หมวดหมู่',
    'stock.gr.none':'ยังไม่มีใบรับของ','stock.gr.received_by':'ผู้รับ',
    'stock.gr.col.code':'รหัส','stock.gr.col.item':'สินค้า',
    'stock.gr.col.ordered':'สั่ง','stock.gr.col.received':'รับ','stock.gr.col.uom':'หน่วย',
    // Admin
    'admin.page_title':'Admin Dashboard — JC-Market','admin.title':'Admin Dashboard',
    'admin.last_update':'อัปเดตล่าสุด: {t}','admin.load_err':'โหลดข้อมูลไม่สำเร็จ: {err}',
    'admin.stat.orders':'ออเดอร์ทั้งหมด','admin.stat.revenue':'รายได้รวม (verified)',
    'admin.stat.pending':'รอตรวจสลิป','admin.stat.verified':'ชำระแล้ว',
    'admin.stat.users':'ผู้ใช้งาน','admin.stat.items':'สินค้าในระบบ',
    'admin.stat.oos':'สินค้าหมด','admin.stat.gr':'ใบรับสินค้า (GR)',
    'admin.fulfill':'สถานะจัดส่ง',
    'admin.pending_slips':'รอตรวจสอบสลิป','admin.recent_orders':'คำสั่งซื้อล่าสุด',
    'admin.daily_chart':'ออเดอร์ 7 วันล่าสุด','admin.top_items':'สินค้าขายดี Top 10',
    'admin.branch_orders':'ยอดสั่งซื้อตามสาขา','admin.fraud_log':'🛡️ บันทึกการพยายามใช้สลิปน่าสงสัย',
    'admin.col.order_no':'เลขที่','admin.col.branch':'สาขา','admin.col.amount':'ยอด',
    'admin.col.slip':'สลิป','admin.col.action':'จัดการ','admin.col.payment':'ชำระ',
    'admin.col.fulfill':'จัดส่ง','admin.col.date':'วันที่','admin.col.no':'#',
    'admin.col.item':'สินค้า','admin.col.code':'รหัส','admin.col.qty':'จำนวน',
    'admin.col.sales':'ยอดขาย','admin.col.order_count':'ออเดอร์',
    'admin.col.order_sum':'จำนวนออเดอร์','admin.col.total':'ยอดรวม',
    'admin.approve':'อนุมัติ','admin.reject':'ปฏิเสธ',
    'admin.confirm_approve':'อนุมัติการชำระเงินนี้?','admin.confirm_reject':'ปฏิเสธการชำระเงินนี้?',
    'admin.verify_ok':'อนุมัติเรียบร้อย','admin.verify_reject_ok':'ปฏิเสธเรียบร้อย',
    'admin.verify_err':'เกิดข้อผิดพลาด: {err}',
    'admin.no_pending':'ไม่มีรายการรอตรวจ','admin.no_data':'ยังไม่มีข้อมูล',
    'admin.fraud.24h':'24 ชม.ล่าสุด:','admin.fraud.7d':'7 วันล่าสุด:','admin.fraud.all':'รวมทั้งหมด:',
    'admin.fraud.col.time':'เวลา','admin.fraud.col.user':'ผู้ใช้','admin.fraud.col.order':'Order',
    'admin.fraud.col.reason':'เหตุผลที่ถูกปฏิเสธ','admin.fraud.col.slip_amt':'ยอดบนสลิป',
    'admin.fraud.col.ref':'Ref','admin.fraud.col.ip':'IP',
    'admin.fraud.none':'ยังไม่มีการปฏิเสธสลิป ✓','admin.fraud.abusers':'⚠️ ผู้ใช้น่าสงสัย (7d): ',
    'admin.ful.pending':'รอจัดส่ง','admin.ful.shipped':'จัดส่งแล้ว',
    'admin.ful.partial':'รับบางส่วน','admin.ful.received':'รับครบแล้ว',
    'admin.pay.pending':'รอชำระ','admin.pay.paid':'รอตรวจ',
    'admin.pay.verified':'ชำระแล้ว','admin.pay.failed':'ไม่ผ่าน','admin.pay.cancelled':'ยกเลิก',
    // Sync info
    'sync.info':'Sync: {at}\n{n} items',
    // Branches / Users admin
    'branches.title':'สาขา','branches.add':'+ เพิ่มสาขา','branches.edit':'แก้ไขสาขา',
    'branches.code':'รหัสสาขา','branches.name':'ชื่อสาขา','branches.bc_customer_no':'Customer No. (BC)',
    'branches.address':'ที่อยู่','branches.phone':'เบอร์โทร','branches.manager_email':'อีเมลผู้จัดการ',
    'branches.tax_id':'เลขผู้เสียภาษี','branches.show_tax_id':'แสดงเลขผู้เสียภาษี',
    'branches.users':'ผู้ใช้','branches.status':'สถานะ','branches.active':'เปิดใช้งาน','branches.inactive':'ปิด',
    'branches.license':'License','branches.actions':'จัดการ','branches.deactivate':'ปิดสาขา',
    'branches.confirm_deactivate':'ปิดสาขานี้? (users ทั้งหมดจะถูกปิดด้วย)',
    'branches.admin_section':'บัญชี Branch Admin ของสาขา',
    'branches.admin_username':'Username ของ Branch Admin','branches.admin_password':'Password',
    'branches.admin_full_name':'ชื่อผู้ดูแลสาขา',
    'users.title':'ผู้ใช้','users.add':'+ เพิ่มผู้ใช้','users.edit':'แก้ไขผู้ใช้',
    'users.username':'Username','users.password':'Password',
    'users.new_password':'Password ใหม่','users.leave_blank':'(เว้นว่างถ้าไม่เปลี่ยน)',
    'users.full_name':'ชื่อเต็ม','users.role':'Role','users.branch':'สาขา','users.phone':'เบอร์โทร',
    'users.can_order':'สั่งซื้อได้','users.active':'เปิดใช้งาน','users.actions':'จัดการ',
    'users.filter_all':'ทุกสาขา','users.reset_pwd':'รีเซ็ต Password',
    'users.deactivate':'ปิด user','users.confirm_deactivate':'ปิด user นี้?',
    'role.super_admin':'Super Admin','role.admin_scm':'SCM Admin','role.finance':'Finance',
    'role.branch_owner':'Branch Owner','role.store_manager':'Store Manager',
    'role.cashier':'แคชเชียร์','role.stock':'พนักงานสต๊อก','role.staff':'พนักงาน','role.fc':'สมาชิกสาขา',
    // legacy aliases (เผื่อข้อมูลเก่า)
    'role.admin':'SCM Admin','role.branch_admin':'Branch Owner','role.manager':'Store Manager',
    'nav.team':'👥 จัดการผู้ใช้',
    // Admin product history
    'shop.col.last_order':'สั่งล่าสุด','shop.last_by':'{branch} · {date}',
    'shop.btn_history':'📋 ประวัติ','shop.never_ordered':'ยังไม่มี',
    'history.title':'ประวัติการสั่งซื้อ','history.item':'สินค้า',
    'history.total_orders':'รวม {n} รายการในระบบ','history.order_no':'เลขที่คำสั่งซื้อ',
    'history.branch':'สาขา','history.qty':'จำนวน','history.unit_price':'ราคา/หน่วย',
    'history.line_total':'รวม','history.payment':'สถานะ','history.date':'วันที่',
    'history.none':'ยังไม่มีการสั่งซื้อสินค้านี้',
  },
  en: {
    // Nav
    'nav.shop':'🛒 Shop','nav.cart':'🧺 Cart','nav.orders':'📋 Orders',
    'nav.stock':'📊 Stock','nav.admin':'⚙️ Admin','nav.logout':'Logout',
    'nav.team':'👥 Users',
    'nav.pending_approvals':'⏳ Pending Approval','nav.approved_list':'✅ Approved','nav.rejected_list':'❌ Rejected',
    // Common
    'common.loading':'Loading...','common.close':'Close','common.confirm':'Confirm','common.cancel':'Cancel',
    'common.search':'Search','common.note':'Note','common.no_data':'No data','common.all':'All',
    'common.qty':'Qty','common.item':'Item','common.code':'Code','common.price':'Price','common.unit':'Unit',
    'common.total':'Total','common.category':'Category','common.save':'Save','common.delete':'Delete',
    'common.branch':'Branch','common.date':'Date','common.status':'Status','common.amount':'Amount',
    // Login
    'login.title':'🛍️ JC-Market','login.sub':'Raw-material ordering system for FC branches',
    'login.username':'Username','login.password':'Password','login.submit':'Sign In',
    'login.page_title':'Sign In — JC-Market',
    // Shop
    'shop.page_title':'Shop — JC-Market',
    'shop.categories':'Categories','shop.search_placeholder':'Search items...',
    'shop.group_general':'General products','shop.group_fruit':'Fresh fruit',
    'shop.overdue_credit':'{n} credit order(s) overdue — fresh fruit ordering is locked until all are settled (general products remain available)',
    'shop.col.code':'Code','shop.col.name':'Item Name','shop.col.price':'Price',
    'shop.col.stock':'Stock','shop.col.uom':'Unit','shop.col.action':'Order',
    'shop.showing':'Showing {n} items','shop.showing_cat':'Showing {n} items in {cat}',
    'shop.no_items':'No items found','shop.out_of_stock':'Out','shop.btn_order':'+ Order',
    'shop.hide_oos':'Hide out-of-stock','shop.oos_hidden':'{n} out-of-stock hidden',
    'shop.oos_alert':'⚠️ Out of stock — cannot order',
    'shop.no_price':'Contact HQ','shop.no_price_btn':'Contact HQ','shop.no_price_alert':'⚠️ Price not available — please contact HQ',
    'shop.modal.add':'Add to Cart','shop.modal.remaining':'Remaining {n} {uom}',
    'shop.added':'Added {name} x{qty} to cart',
    'shop.others':'Others',
    // Cart
    'cart.page_title':'Cart — JC-Market','cart.title':'Shopping Cart',
    'cart.empty':'Cart is empty','cart.choose':'Browse Items','cart.choose_more':'Add More',
    'cart.col.item':'Item','cart.col.price_unit':'Price/Unit','cart.col.qty':'Qty',
    'cart.col.uom':'Unit','cart.col.total':'Total',
    'cart.remaining':'Remaining','cart.clear':'Clear Cart','cart.checkout':'Proceed to Payment',
    'cart.items_count':'{n} items','cart.vat_note':'VAT not included (calculated at checkout)',
    'cart.group_locked':'Group: {grp} · cannot be combined with another category in the same order',
    'cart.removed':'Item removed','cart.confirm_clear':'Clear entire cart?',
    // Checkout
    'checkout.page_title':'Payment — JC-Market',
    'checkout.confirm':'Confirm Order','checkout.items':'Order Items',
    'checkout.note_label':'Note (optional)','checkout.note_placeholder':'Additional notes...',
    'checkout.summary':'Order Summary','checkout.subtotal':'Subtotal','checkout.grand':'Total',
    'checkout.vat_note':'VAT is calculated from D365 BC upon confirmation','checkout.place':'Place Order',
    'checkout.pay':'Payment','checkout.pay_expired':'⏰ Payment time expired',
    'checkout.pay_timeout_sub':'Please pay within the time limit or the order will be auto-cancelled',
    'checkout.pay_cancelled_sub':'Order auto-cancelled, redirecting...',
    'checkout.step1_done':'Order {no} created','checkout.step2':'Scan PromptPay QR to pay',
    'checkout.step3':'Upload transfer slip','checkout.upload_slip':'Upload Slip',
    'checkout.upload_hint':'Click or drag slip file here',
    'checkout.upload_types':'Supports JPG, PNG, PDF (max 10MB)',
    'checkout.upload_btn':'Submit Slip','checkout.uploading':'Uploading...',
    'checkout.qr_title':'PromptPay QR','checkout.qr_hint':'Scan with your banking app',
    'checkout.vat_breakdown':'Items ฿{sub} + VAT ฿{vat}',
    'checkout.bc_po':'BC Purchase Order','checkout.bc_so':'BC Sales Order',
    'checkout.order_no_label':'Order',
    'checkout.pending_title':'Slip uploaded — awaiting Finance review',
    'checkout.pending_msg':'This order will be completed only after Finance has reviewed it.',
    'checkout.payment_method':'Payment method',
    'checkout.pay_immediate':'Pay now (transfer + upload slip)',
    'checkout.pay_credit_7d':'Credit 7 days (settle within 7 days)',
    'checkout.credit_title':'Order placed on 7-day credit',
    'checkout.credit_msg':'Payment due by {due} · upload the slip from the Orders page once paid.',
    'checkout.credit_overdue':'⚠ Credit payment overdue (7-day)',
    'checkout.credit_overdue_sub':'You can still upload a slip · this branch cannot order fresh fruit again until all outstanding credits are settled',
    'checkout.transfer_amount':'Transfer amount','checkout.sender':'Sender','checkout.receiver':'Receiver',
    'checkout.ref':'Ref',
    'checkout.auto_pass_hint':'✓ Auto-check passed — awaiting Finance approval',
    'checkout.auto_fail_hint':'⚠ Auto-check failed:',
    'checkout.view_orders':'View Orders','checkout.back_shop':'Back to Shop',
    'checkout.save_qr':'💾 Save QR','checkout.download_pdf':'📄 Download PDF',
    'checkout.pdf_title':'Order / คำสั่งซื้อ','checkout.pdf_order_no':'Order No.',
    'checkout.pdf_date':'Date','checkout.pdf_branch':'Branch',
    'checkout.pdf_items':'Items','checkout.pdf_subtotal':'Subtotal',
    'checkout.pdf_vat':'VAT','checkout.pdf_total':'Total Due',
    'checkout.pdf_scan':'Scan PromptPay QR to pay','checkout.pdf_print':'🖨️ Print / Save as PDF',
    // Orders
    'orders.page_title':'Orders — JC-Market','orders.title':'Orders',
    'orders.empty':'No orders yet',
    'orders.status.pending':'Awaiting Payment','orders.status.paid':'Slip Submitted',
    'orders.status.verified':'Approved','orders.status.failed':'Rejected','orders.status.cancelled':'Cancelled',
    'orders.fulfill.pending':'Pending Ship','orders.fulfill.shipped':'Shipped',
    'orders.fulfill.partial':'Partial','orders.fulfill.received':'Received',
    'orders.items':'Items','orders.subtotal':'Subtotal','orders.vat':'VAT','orders.grand':'Total',
    'orders.note_prefix':'Note: {note}','orders.pay':'Payment',
    'orders.pay_hint':'Please pay within the time limit',
    'orders.credit_due':'7-day credit · payment due by',
    'orders.credit_overdue':'Overdue (7-day credit)',
    'orders.scan_qr':'Scan with your banking app','orders.upload_click':'Click to upload slip',
    'orders.upload_types':'Supports JPG, PNG, PDF','orders.send_slip':'Submit Slip',
    'orders.uploading':'Uploading...','orders.cancel_order':'✕ Cancel Order',
    'orders.cancel_reason_prompt':'Please enter a reason for cancellation:',
    'orders.cancel_default_reason':'Cancelled by user',
    'orders.cancelled_title':'Order Cancelled','orders.pay_timeout':'Payment time expired, auto-cancelling...',
    'orders.reorder':'🔄 Reorder','orders.reorder_confirm':'Reorder from this list?',
    'orders.reorder_loading':'Creating new order...',
    'orders.slip':'Transfer Slip','orders.verified_at':'Verified {at}',
    'orders.admin.verify':'Verify Payment','orders.admin.approve':'Approve','orders.admin.reject':'Reject',
    'orders.fulfill_title':'Shipment / Receiving','orders.wait_hq':'Awaiting shipment from HQ (BC Post PO Receive)',
    'orders.check_bc':'🔄 Check from BC','orders.receive':'📦 Receive Items',
    'orders.received_ok':'Fully received','orders.history':'Receive History','orders.received_by':'Received by',
    'orders.rcv.item':'Item','orders.rcv.order':'Order','orders.rcv.bc_recv':'BC Recv',
    'orders.rcv.fc_rcv':'FC Recv','orders.rcv.this_time':'This time',
    'orders.rcv.confirm':'✅ Confirm Receive','orders.rcv.note_placeholder':'Note (optional)',
    'orders.rcv.no_items':'No items to receive',
    'orders.bc.po':'BC Purchase Order','orders.bc.so':'BC Sales Order','orders.bc.invoice':'BC Invoice',
    'orders.bc.posted':'(Posted)',
    'orders.view_receipt':'🧾 View Receipt',
    'orders.gr.title':'Received Successfully','orders.gr.doc':'Goods Receipt (GR)','orders.gr.order':'Order',
    'orders.gr.date':'Receive Date','orders.gr.back':'Back to Order','orders.gr.stock':'View Branch Stock',
    'orders.gr.load_err':'GR created but failed to load document: {err}',
    'orders.receipt.title':'Receipt','orders.receipt.subtitle':'Receipt / Tax Invoice',
    'orders.receipt.seller':'Seller','orders.receipt.issue_date':'Issue Date',
    'orders.receipt.buyer':'Buyer / Branch','orders.receipt.order_no':'Order Number',
    'orders.receipt.no':'#','orders.receipt.code':'Code','orders.receipt.item':'Item',
    'orders.receipt.qty':'Qty','orders.receipt.price':'Price/Unit','orders.receipt.line_total':'Total',
    'orders.receipt.subtotal':'Subtotal','orders.receipt.vat':'VAT (7%)','orders.receipt.grand':'Grand Total',
    'orders.receipt.paid':'Payment Received','orders.receipt.via':'Via: PromptPay | Paid: {d}',
    'orders.receipt.issued_by':'Approved by: {name}','orders.receipt.print':'🖨️ Print Receipt',
    'orders.receipt.print_btn':'🖨️ Print',
    'orders.receipt.not_found':'Receipt not found for this order',
    'orders.receipt.load_err':'Failed to load receipt: {err}',
    'orders.expired':'⏰ Expired',
    'orders.pending_review':'Slip submitted — awaiting Finance review',
    'orders.reject_title':'❌ Slip rejected',
    'orders.rejected_at':'At','orders.rejected_by':'By',
    'orders.retry_count':'Re-upload attempt #{n}',
    'orders.reupload_title':'📤 Upload a new slip',
    'orders.checking_bc':'Checking from BC...','orders.bc_shipped':'Shipment found in BC! Status updated',
    'orders.bc_checked':'Checked','orders.bc_not_found':'No shipment found in BC yet',
    'orders.bc_synced':'Synced {n} orders',
    // Stock
    'stock.page_title':'Branch Stock — JC-Market','stock.title':'Branch Stock',
    'stock.items':'Items in Stock','stock.gr_history':'Receive History',
    'stock.gr_history_full':'Goods Receipt History (GR)',
    'stock.issue_history':'Issue History',
    'stock.search':'Search items...','stock.col.code':'Code','stock.col.item':'Item',
    'stock.col.received':'Received Qty','stock.col.uom':'Unit','stock.col.category':'Category',
    'stock.col.issued':'Issued','stock.col.onhand':'On Hand',
    'stock.empty':'No stock data — will update when items are received',
    'stock.summary.items':'Items','stock.summary.qty':'Total Received','stock.summary.cats':'Categories',
    'stock.gr.none':'No goods receipts yet','stock.gr.received_by':'Received by',
    'stock.gr.col.code':'Code','stock.gr.col.item':'Item',
    'stock.gr.col.ordered':'Ordered','stock.gr.col.received':'Received','stock.gr.col.uom':'Unit',
    // Admin
    'admin.page_title':'Admin Dashboard — JC-Market','admin.title':'Admin Dashboard',
    'admin.last_update':'Last updated: {t}','admin.load_err':'Failed to load data: {err}',
    'admin.stat.orders':'Total Orders','admin.stat.revenue':'Total Revenue (verified)',
    'admin.stat.pending':'Pending Slips','admin.stat.verified':'Paid',
    'admin.stat.users':'Users','admin.stat.items':'Items',
    'admin.stat.oos':'Out of Stock','admin.stat.gr':'Goods Receipts',
    'admin.fulfill':'Fulfillment Status',
    'admin.pending_slips':'Pending Slip Review','admin.recent_orders':'Recent Orders',
    'admin.daily_chart':'Orders — Last 7 Days','admin.top_items':'Top 10 Best-Selling Items',
    'admin.branch_orders':'Orders by Branch','admin.fraud_log':'🛡️ Suspicious Slip Attempts',
    'admin.col.order_no':'Order#','admin.col.branch':'Branch','admin.col.amount':'Amount',
    'admin.col.slip':'Slip','admin.col.action':'Action','admin.col.payment':'Payment',
    'admin.col.fulfill':'Fulfillment','admin.col.date':'Date','admin.col.no':'#',
    'admin.col.item':'Item','admin.col.code':'Code','admin.col.qty':'Qty',
    'admin.col.sales':'Sales','admin.col.order_count':'Orders',
    'admin.col.order_sum':'Order Count','admin.col.total':'Total',
    'admin.approve':'Approve','admin.reject':'Reject',
    'admin.confirm_approve':'Approve this payment?','admin.confirm_reject':'Reject this payment?',
    'admin.verify_ok':'Approved','admin.verify_reject_ok':'Rejected',
    'admin.verify_err':'Error: {err}',
    'admin.no_pending':'No pending reviews','admin.no_data':'No data',
    'admin.fraud.24h':'Last 24h:','admin.fraud.7d':'Last 7d:','admin.fraud.all':'All time:',
    'admin.fraud.col.time':'Time','admin.fraud.col.user':'User','admin.fraud.col.order':'Order',
    'admin.fraud.col.reason':'Rejection Reason','admin.fraud.col.slip_amt':'Slip Amount',
    'admin.fraud.col.ref':'Ref','admin.fraud.col.ip':'IP',
    'admin.fraud.none':'No slip rejections ✓','admin.fraud.abusers':'⚠️ Suspicious users (7d): ',
    'admin.ful.pending':'Pending Ship','admin.ful.shipped':'Shipped',
    'admin.ful.partial':'Partial','admin.ful.received':'Received',
    'admin.pay.pending':'Pending','admin.pay.paid':'To Review',
    'admin.pay.verified':'Paid','admin.pay.failed':'Failed','admin.pay.cancelled':'Cancelled',
    // Sync info
    'sync.info':'Sync: {at}\n{n} items',
    // Branches / Users admin
    'branches.title':'Branches','branches.add':'+ Add Branch','branches.edit':'Edit Branch',
    'branches.code':'Branch Code','branches.name':'Branch Name','branches.bc_customer_no':'Customer No. (BC)',
    'branches.address':'Address','branches.phone':'Phone','branches.manager_email':'Manager Email',
    'branches.tax_id':'Tax ID','branches.show_tax_id':'Show Tax ID',
    'branches.users':'Users','branches.status':'Status','branches.active':'Active','branches.inactive':'Inactive',
    'branches.license':'License','branches.actions':'Actions','branches.deactivate':'Deactivate',
    'branches.confirm_deactivate':'Deactivate this branch? (all users will be deactivated too)',
    'branches.admin_section':'Branch Admin Account',
    'branches.admin_username':'Branch Admin Username','branches.admin_password':'Password',
    'branches.admin_full_name':'Branch Admin Full Name',
    'users.title':'Users','users.add':'+ Add User','users.edit':'Edit User',
    'users.username':'Username','users.password':'Password',
    'users.new_password':'New Password','users.leave_blank':'(leave blank to keep)',
    'users.full_name':'Full Name','users.role':'Role','users.branch':'Branch','users.phone':'Phone',
    'users.can_order':'Can Order','users.active':'Active','users.actions':'Actions',
    'users.filter_all':'All branches','users.reset_pwd':'Reset Password',
    'users.deactivate':'Deactivate','users.confirm_deactivate':'Deactivate this user?',
    'role.super_admin':'Super Admin','role.admin_scm':'SCM Admin','role.finance':'Finance',
    'role.branch_owner':'Branch Owner','role.store_manager':'Store Manager',
    'role.cashier':'Cashier','role.stock':'Stock Keeper','role.staff':'Staff','role.fc':'Member',
    // legacy aliases
    'role.admin':'SCM Admin','role.branch_admin':'Branch Owner','role.manager':'Store Manager',
    'nav.team':'👥 Team',
    // Admin product history
    'shop.col.last_order':'Last Order','shop.last_by':'{branch} · {date}',
    'shop.btn_history':'📋 History','shop.never_ordered':'Never',
    'history.title':'Order History','history.item':'Item',
    'history.total_orders':'{n} orders total','history.order_no':'Order No.',
    'history.branch':'Branch','history.qty':'Qty','history.unit_price':'Unit Price',
    'history.line_total':'Total','history.payment':'Status','history.date':'Date',
    'history.none':'No orders for this item yet',
  }
};

/* Category mapping (BC sends EN only) */
// Top-level grouping for the shop sidebar. Anything in FRUIT_CATEGORIES rolls
// up under "ผลไม้สด"; everything else falls under "สินค้าทั่วไป". Add more
// category codes to FRUIT_CATEGORIES when BC introduces them.
const FRUIT_CATEGORIES = new Set(['Fruit fresh']);
function categoryGroup(cat){ return FRUIT_CATEGORIES.has(cat) ? 'fruit' : 'general'; }

const CATEGORY_I18N = {
  'Fruit fresh':      { th:'ผลไม้สด', en:'Fruit fresh' },
  'Tea Leaves':       { th:'ใบชา', en:'Tea Leaves' },
  'Ingredient':       { th:'วัตถุดิบ', en:'Ingredient' },
  'Topping':          { th:'ท็อปปิ้ง', en:'Topping' },
  'Packging':         { th:'บรรจุภัณฑ์', en:'Packging' },
  'Cleaning':         { th:'ของทำความสะอาด', en:'Cleaning' },
  'Counter':          { th:'ของใช้หน้าร้าน', en:'Counter' },
  'Equipment Kiosk':  { th:'อุปกรณ์ Kiosk', en:'Equipment Kiosk' },
  'Machine':          { th:'เครื่องจักร', en:'Machine' },
  'Spare part':       { th:'อะไหล่', en:'Spare part' },
  'Uniform':          { th:'ยูนิฟอร์ม', en:'Uniform' },
  'Printing and Stationary': { th:'สิ่งพิมพ์/เครื่องเขียน', en:'Printing and Stationary' },
  'Premium gift':     { th:'ของพรีเมียม/ของขวัญ', en:'Premium gift' },
  'RM-Bakery':        { th:'วัตถุดิบเบเกอรี่', en:'RM-Bakery' },
  'Finished goods Beverage': { th:'เครื่องดื่มสำเร็จรูป', en:'Finished goods Beverage' },
  'Miscellaneous':    { th:'เบ็ดเตล็ด', en:'Miscellaneous' },
  'Other':            { th:'อื่นๆ', en:'Other' },
  'วัตถุดิบ':          { th:'วัตถุดิบ', en:'Raw Material' },
  'บรรจุภัณฑ์':        { th:'บรรจุภัณฑ์', en:'Packaging' },
  'ท็อปปิ้ง':           { th:'ท็อปปิ้ง', en:'Topping' },
  'อื่นๆ':             { th:'อื่นๆ', en:'Other' },
};
function catName(c){
  if (!c) return '';
  const m = CATEGORY_I18N[c];
  return m ? (m[getLang()] || c) : c;
}
function roleName(r){
  const key = 'role.' + (r || 'fc');
  const lang = getLang();
  return (I18N[lang] && I18N[lang][key]) || r || '';
}

function itemName(it){
  if (!it) return '';
  if (getLang() === 'en') return it.item_name_en || it.name_en || it.item_name || it.name || '';
  return it.item_name || it.name || it.name_en || it.item_name_en || '';
}

function getLang(){ return localStorage.getItem(LANG_KEY) || 'th'; }
function setLang(lang){
  if (lang !== 'th' && lang !== 'en') lang = 'th';
  localStorage.setItem(LANG_KEY, lang);
  document.documentElement.lang = lang;
  applyI18n();
  try { if (typeof window.onLangChange === 'function') window.onLangChange(lang); } catch(e){ console.error(e); }
}
function t(key, vars){
  const lang = getLang();
  let s = (I18N[lang] && I18N[lang][key]) || (I18N.th[key]) || key;
  if (vars) for (const k in vars) s = s.replace(new RegExp('\\{'+k+'\\}','g'), vars[k]);
  return s;
}
function applyI18n(root){
  root = root || document;
  // Title
  const titleKey = document.body && document.body.dataset && document.body.dataset.i18nTitle;
  if (titleKey) document.title = t(titleKey);
  // data-i18n → textContent
  root.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
  // data-i18n-html → innerHTML (for tags with icons/markup)
  root.querySelectorAll('[data-i18n-html]').forEach(el => {
    const key = el.getAttribute('data-i18n-html');
    if (key) el.innerHTML = t(key);
  });
  // data-i18n-placeholder
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) el.setAttribute('placeholder', t(key));
  });
  // data-i18n-title (tooltip)
  root.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    if (key) el.setAttribute('title', t(key));
  });
}
// Map known Thai server error messages → i18n keys (so backend stays untouched)
const SERVER_ERR_I18N = {
  'ยังไม่มีใบเสร็จ':'orders.receipt.not_found',
  'ไม่มีรายการรับของ':'orders.rcv.no_items',
};
function translateErr(msg){
  if (!msg) return msg;
  for (const th in SERVER_ERR_I18N) {
    if (msg.indexOf(th) !== -1) return t(SERVER_ERR_I18N[th]);
  }
  return msg;
}
// Set html lang on first load
document.documentElement.lang = getLang();

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { 'Authorization': 'Bearer ' + getToken() } : {}),
      ...(opts.headers || {}),
    },
  });
  if (r.status === 401) { clearAuth(); return; }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(translateErr(data.error) || r.statusText);
  return data;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

async function updateCartBadge() {
  try {
    const r = await api('/api/cart/count');
    const badge = document.getElementById('cartBadge');
    if (badge) {
      badge.textContent = r.count || '';
      badge.style.display = r.count > 0 ? 'inline-flex' : 'none';
    }
    // Overdue-credit warning on the shop page. Banner is opt-in: page must
    // include #overdueCreditBanner. We can't filter fruit items themselves
    // — the FC sees the rule explained and the backend rejects fruit adds.
    const banner = document.getElementById('overdueCreditBanner');
    if (banner) {
      const n = r.overdue_credit_count || 0;
      if (n > 0) {
        banner.innerHTML = `<strong>⚠ ${t('shop.overdue_credit', { n })}</strong>`;
        banner.style.display = 'block';
      } else {
        banner.style.display = 'none';
      }
    }
  } catch {}
}

function renderNav(active) {
  const u = getUser();
  if (!u) return '';
  // Keep in sync with auth.js HQ_ROLES.
  const HQ_ROLES = ['super_admin','admin_scm','finance'];
  const isHq = HQ_ROLES.includes(u.role);
  const isFinance = u.role === 'finance';
  const links = [];
  if (isFinance) {
    // Finance is a focused role — just the three approval queues. They
    // don't shop, manage users, or browse the full orders list, so those
    // links are deliberately omitted.
    links.push(['approvals.html?tab=pending','nav.pending_approvals']);
    links.push(['approvals.html?tab=approved','nav.approved_list']);
    links.push(['approvals.html?tab=rejected','nav.rejected_list']);
  } else if (isHq) {
    // super_admin / admin_scm — full HQ visibility minus the cart/stock flow
    links.push(['index.html','nav.shop']);
    links.push(['orders.html','nav.orders']);
  } else {
    // Branch users — full shop flow
    links.push(['index.html','nav.shop']);
    links.push(['cart.html','nav.cart']);
    links.push(['orders.html','nav.orders']);
    links.push(['stock-balance.html','nav.stock']);
  }
  if (!isFinance && (isHq || u.role === 'branch_owner')) links.push(['team.html','nav.team']);
  if (!isFinance && isHq) links.push(['admin.html','nav.admin']);
  const lang = getLang();
  const otherLang = lang === 'th' ? 'en' : 'th';
  const flag = lang === 'th' ? '🇹🇭 TH' : '🇬🇧 EN';
  const html = `<div class="nav">
    <div class="brand">JC-Market</div>
    ${links.map(([h,k])=>{
      if (h === 'cart.html') {
        return `<a href="${h}" class="${active===h?'active':''}"><span data-i18n="${k}">${t(k)}</span><span id="cartBadge" class="cart-badge" style="display:none"></span></a>`;
      }
      return `<a href="${h}" class="${active===h?'active':''}" data-i18n="${k}">${t(k)}</a>`;
    }).join('')}
    <div class="spacer"></div>
    <a href="#" id="langToggle" title="Switch language" style="padding:4px 10px;border:1px solid var(--border);border-radius:8px">${flag}</a>
    <div class="user">${u.full_name} (${u.branch_name||u.role})</div>
    <a href="#" onclick="clearAuth();return false" data-i18n="nav.logout">${t('nav.logout')}</a>
  </div>`;
  setTimeout(() => {
    updateCartBadge();
    const tg = document.getElementById('langToggle');
    if (tg) tg.onclick = (e) => { e.preventDefault(); setLang(getLang()==='th'?'en':'th'); };
  }, 50);
  return html;
}

// Auto-apply i18n on DOMContentLoaded for static elements
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => applyI18n());
} else {
  applyI18n();
}
