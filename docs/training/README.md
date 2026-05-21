# JC-Market — คู่มือเทรนนิ่งผู้ใช้

แยกเป็น 4 ไฟล์ตามบทบาท:

| Role | ไฟล์ | ใครใช้ |
|---|---|---|
| 🏪 FC (Franchise) | [jf-branch-owner.md](./jf-branch-owner.md) | สาขาแฟรนไชส์ — JF001-JF059 |
| 🏢 JC (Master / Company-owned) | [jc-master.md](./jc-master.md) | สาขาบริษัทเอง — JC002-JC010 |
| 💰 Finance | [finance.md](./finance.md) | ทีมการเงิน HQ — ตรวจสลิป |
| 🛠 IT / Admin | [it-admin.md](./it-admin.md) | super_admin / admin_scm |

ผู้ใช้แต่ละคนได้รหัสจากสรุป credentials ที่ HQ จัดส่งให้ — รายการแบบ CSV ใน `imports/` (gitignored)

## หลักการของระบบ

```
FC สั่ง   → ชำระเงิน → Finance ตรวจสลิป → BC SO+PO + ใบเสร็จ → รับของ
JC สั่ง   → BC TO หรือ PO ทันที (ไม่ชำระเงิน) → รับของ
```

Login URL: `http://<server>:3863` (Production จะมี subdomain ของ JC-Market)
