# Flow รวม: JC-Market → TMS → Ticket (ปัญหาการจัดส่ง/สินค้า)

เอกสารนี้รวมเส้นทางการทำงานตั้งแต่สาขาสั่งของ ผ่านการจัดส่งของ TMS ไปจนถึงการจัดการปัญหา
ด้วย **Ticket** ที่วน loop กลับมาส่งใหม่ หรือปิดจบด้วยการคืนเงิน/เครดิต

> **สถานะของเอกสาร**
> - **JC-Market → TMS** = ระบบที่มีอยู่จริง ตรวจแล้วว่ารันได้ (บูต `server.js` + ยิง `/api/tms/*` ผ่าน)
> - **🎫 Ticket** = flow ที่ออกแบบ **เสนอ (proposed)** ยังไม่มี implementation
>   ตอนนี้โค้ดมีแค่สถานะ shipment `failed` (ป้าย "ส่งไม่สำเร็จ" ใน `driver.html`) ที่
>   **นิยามไว้แต่ยังไม่มี endpoint ให้กด** — flow นี้ทำให้มันถูกใช้งานจริงและต่อวงจรจนจบ

หน้าเว็บเวอร์ชันมีสี/แผนภาพเต็ม: ดู artifact ที่แชร์ในแชต

---

## 1. เส้นทางรวม 3 ระบบ

```mermaid
flowchart TD
  subgraph JCM [JC-Market]
    direction TB
    CO([สาขา checkout]):::start --> GATE{FC หรือ JC?}
    GATE -->|FC| FIN[Finance verify อนุมัติสลิป]:::fc
    GATE -->|JC| DIRECT[ข้าม Finance]:::jc
    FIN --> BC[สร้างเอกสาร BC: SO+PO / TRO / PO]:::bc
    DIRECT --> BC
    BC --> ROUTE{ช่องทางส่ง}:::gold
  end

  ROUTE -->|ของสด supplier| DROP[Shipment · drop-ship]:::fresh
  ROUTE -->|ทั่วไป cti| PICK[คลังจัดของ → Shipment]:::pick

  subgraph TMS [TMS]
    direction TB
    PICK --> POOL[pool รอ trip]:::trip --> TRIP[สร้าง Trip]:::trip --> DISP[คนขับออกรถ dispatched]:::trip --> ARRIVE{ถึงสาขา}
  end

  DROP -.-> ARRIVE

  ARRIVE -->|ส่ง+รับปกติ| POD[POD: รูป+เซ็นรับ · Shipment delivered]:::done
  ARRIVE -->|ส่งไม่สำเร็จ| F1[Shipment = failed]:::dead
  POD -->|ตรวจรับพบปัญหา| T2
  F1 --> T1
  POD -->|ครบถ้วน OK| OKEND([จบ · ส่งสำเร็จ]):::done

  subgraph TK [Ticket · ปัญหาการจัดส่ง/สินค้า · proposed]
    direction TB
    T1[[เปิด Ticket: delivery_failed]]:::tk
    T2[[เปิด Ticket: damaged / wrong / short]]:::tk
    T1 --> TRIAGE{คัดแยกตามประเภท}:::tk
    T2 --> TRIAGE
    TRIAGE -->|ส่งไม่สำเร็จ| RTMS[TMS นัดส่งใหม่]:::tk
    TRIAGE -->|ของมีปัญหา| RSCM[SCM ตัดสิน]:::tk
    RSCM -->|ส่งทดแทน| REPLACE[คลัง re-pick]:::tk
    RSCM -->|คืนเงิน/เครดิต| REFUND[Finance + BC credit memo]:::tk
    RSCM -->|ปฏิเสธเคลม| REJECT[ปิด · ไม่ชดเชย]:::dead
  end

  RTMS -->|Shipment กลับ pending| POOL
  REPLACE -->|Shipment ใหม่| POOL
  REFUND --> CLOSED([Ticket resolved → closed]):::done
  REJECT --> CLOSED

  classDef start fill:#efeae2,stroke:#8a7d66,color:#2a2118;
  classDef fc fill:#efe8f3,stroke:#8a6d9c,color:#3c2f47;
  classDef jc fill:#e3edf2,stroke:#4a7a94,color:#274050;
  classDef bc fill:#fff,stroke:#ad9c82,color:#2a2118;
  classDef gold fill:#ad9c82,stroke:#8a7d66,color:#fff;
  classDef fresh fill:#f6ecd8,stroke:#b07a2c,color:#6b4a15;
  classDef pick fill:#f4efe7,stroke:#8a7d66,color:#2a2118;
  classDef trip fill:#e6eef1,stroke:#4a7a94,color:#274050;
  classDef done fill:#e7f1e9,stroke:#3f7d55,color:#234a30;
  classDef dead fill:#f4e3df,stroke:#a85a4c,color:#5c2a22;
  classDef tk fill:#f6e5e1,stroke:#b1503f,color:#5e281f;
```

> ส่วน JC-Market + TMS แบบละเอียด (5 lane, state machine ของ order/shipment/trip)
> ดูที่เอกสาร flow เดิม — เอกสารนี้ย่อสันหลักไว้เพื่อโฟกัสส่วน Ticket

---

## 2. Ticket เกิดที่ไหนได้บ้าง

จุดกำเนิด Ticket ทั้งหมดอยู่ปลายทาง TMS — ตอนคนขับส่ง หรือตอนสาขาตรวจรับ

| จุดเกิด | ใครเปิด | ประเภท | ผลกับ Shipment |
|---|---|---|---|
| คนขับถึงสาขาแต่ส่งไม่ได้ (สาขาปิด / ปฏิเสธรับ / หาที่อยู่ไม่เจอ) | คนขับ (driver app) | `delivery_failed` | ไม่เกิด `delivered` · ตั้ง **`failed`** |
| รับของแล้วพบเสียหาย / แตก / เน่า | สาขา | `damaged` | คง `delivered` · แนบ ticket |
| ได้ของผิดรุ่น / ผิดรายการ | สาขา | `wrong_item` | คง `delivered` · แนบ ticket |
| จำนวนไม่ครบ / ขาด | สาขา | `short` | คง `delivered` · แนบ ticket |
| อื่น ๆ (บิลผิด, สอบถาม) | สาขา / SCM | `other` | ไม่แตะ shipment |

---

## 3. ใครรับผิดชอบ + ทางแก้

คัดแยกตามประเภท → มอบหมายเจ้าของ → เลือกวิธีแก้ ซึ่งจะวน loop กลับ TMS หรือปิดจบ

| ประเภท | เจ้าของ | ทางแก้ | ปลายทาง |
|---|---|---|---|
| `delivery_failed` | TMS manager | นัดส่งใหม่ / เปลี่ยนรอบรถ | ↺ กลับ pool → trip ใหม่ |
| `damaged` / `wrong_item` | SCM (`admin_scm`) | ส่งทดแทน (คลัง re-pick) | ↺ Shipment ใหม่ → TMS |
| `short` | SCM | ส่งเพิ่มส่วนที่ขาด / ลดยอดบิล | ↺ หรือ Finance credit |
| `damaged`/`short` (ไม่ส่งซ้ำ) | Finance | คืนเงิน / ใบลดหนี้ (BC credit memo) | ✓ closed |
| เคลมไม่ผ่าน | SCM | ปฏิเสธพร้อมเหตุผล | ✓ closed (rejected) |

---

## 4. วงจร Ticket + โครงข้อมูลที่เสนอ

### สถานะ Ticket

```
open → assigned → in_progress → resolved → closed
                      └─(rejected)────────────┘
```

- ถ้าวิธีแก้คือ "ส่งใหม่/ทดแทน" → ticket ค้าง `in_progress` จนกว่า shipment รอบใหม่จะ `delivered` แล้วค่อย auto-resolve
- `rejected` จาก `assigned`/`in_progress` ก็ปิด (`closed`) ได้

### ตาราง `tickets` (เสนอ)

```
tickets
  id, ticket_number          -- TCK2026...
  order_id, shipment_id       -- FK → orders / shipments
  branch_code
  type          -- delivery_failed | damaged | wrong_item | short | other
  severity      -- low | normal | high
  status        -- open | assigned | in_progress | resolved | closed
  opened_by, opened_role
  assigned_to
  resolution    -- redeliver | replace | refund | credit | reject
  resolution_note
  new_shipment_id             -- ← loop กลับ TMS
  bc_credit_memo_no           -- ← Finance
  created_at, resolved_at

ticket_events   -- audit log ต่อ ticket
ticket_photos   -- รูปหลักฐานปัญหา
```

### API ที่เสนอ

| Method | Path | ใคร | หน้าที่ |
|---|---|---|---|
| POST | `/api/tms/tickets` | สาขา / คนขับ | เปิด ticket |
| GET | `/api/tms/tickets` | HQ (กรอง type/status/branch) | รายการ |
| PATCH | `/api/tms/tickets/:id` | `requireTmsManager` / `admin_scm` | มอบหมาย + เปลี่ยนสถานะ |
| POST | `/api/tms/tickets/:id/resolve` | เจ้าของ ticket | บันทึกวิธีแก้ (loop / refund / reject) |
| POST | `/api/tms/driver/shipments/:id/fail` | คนขับ | กด "ส่งไม่สำเร็จ" → `failed` + เปิด ticket อัตโนมัติ |

---

## 5. ต่อกับของเดิมยังไง

- **ปลุกสถานะ `failed` ที่ค้างอยู่** — เพิ่ม `POST /api/tms/driver/shipments/:id/fail` คู่กับ POD เดิม
  ให้คนขับกด "ส่งไม่สำเร็จ" → ตั้ง shipment `failed` + เปิด ticket อัตโนมัติ (ป้าย `pill-failed` ใน `driver.html` มีอยู่แล้ว)
- **Trip completion ไม่พัง** — โค้ดปัจจุบันปิด trip เมื่อทุก stop อยู่ใน `delivered/failed/cancelled` อยู่แล้ว
  (`server.js` ~บรรทัด 4240) ดังนั้น stop ที่ `failed` ไม่บล็อกการปิด trip — ตรงกับ flow นี้พอดี
- **Loop ส่งใหม่ = ใช้กลไกเดิม** — "นัดส่งใหม่/ทดแทน" สร้าง shipment รอบใหม่ผ่าน `createShipmentForOrder`
  (idempotent) สถานะ `pending` → เข้า pool → วาง trip ตามปกติ ไม่ต้องมี logic ขนส่งใหม่
- **Refund/credit ผูก BC** — ปลายทางคืนเงินออกใบลดหนี้ (credit memo) ใน BC คล้าย pattern `postOrderToBC`
  ที่มีอยู่ · เก็บเลขไว้ที่ `tickets.bc_credit_memo_no`
- **RBAC เดิมใช้ต่อได้** — เปิด ticket: สาขา/คนขับ · จัดการ: `requireTmsManager` (delivery) + `admin_scm` (goods) · คืนเงิน: `finance`
- **แท็บใหม่ใน `tms-admin.html`** — เพิ่ม "Tickets" ต่อจาก 5 แท็บเดิม
  (จัดของ · ประวัติ · carriers · trips · deliveries) ใช้โครง badge/modal ชุดเดียวกัน

---

_อ้างอิงจากโค้ดจริง: `server.js` (`routeOrderFulfilment`, `createShipmentForOrder`, `/api/tms/*`),
`public/tms-admin.html`, `public/driver.html` และ `CLAUDE.md`_
