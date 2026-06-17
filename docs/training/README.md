# JC-Market — คู่มือเทรนนิ่งผู้ใช้

แยกตามบทบาท:

| Role | ไฟล์ | ใครใช้ |
|---|---|---|
| 🏪 FC (Franchise) | [jf-branch-owner.md](./jf-branch-owner.md) | สาขาแฟรนไชส์ — JF001-JF059 |
| 🏢 JC (Master / Company-owned) | [jc-master.md](./jc-master.md) | สาขาบริษัทเอง — JC002-JC010 |
| 💰 Finance | [finance.md](./finance.md) | ทีมการเงิน HQ — ตรวจสลิป |
| 🛠 IT / Admin | [it-admin.md](./it-admin.md) | super_admin / admin_scm |
| 🏭 TMS — คลัง CTI | [tms-cti.md](./tms-cti.md) | ผู้จัดเที่ยวรถที่คลัง CTI (HQ) |
| 🚚 TMS — ขนส่ง | [tms-transport.md](./tms-transport.md) | คนขับ (แอปมือถือ) |

ผู้ใช้แต่ละคนได้รหัสจากสรุป credentials ที่ HQ จัดส่งให้ — รายการแบบ CSV ใน `imports/` (gitignored)

## หลักการของระบบ

```
FC สั่ง    → ชำระเงิน → Finance ตรวจสลิป → BC SO+PO + ใบเสร็จ → รับของ
JC สั่ง    → BC TO หรือ PO ทันที (ไม่ชำระเงิน) → รับของ
ทุกออเดอร์ → สร้าง shipment (ต้นทาง CTI) → คลังจัดเที่ยว → คนขับส่ง + POD   ← TMS
```

Login URL: `http://<server>:3863` (Production จะมี subdomain ของ JC-Market)
