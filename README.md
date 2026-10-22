# หารกัน (HarnKan)

แอปหารบิลแบบ Splitwise สำหรับใช้กับเพื่อน ถ่ายใบเสร็จแล้ว Gemini อ่านรายการ, Service charge, VAT ให้
จากนั้นแต่ละคนเข้ามาติ๊กรายการของตัวเองหรือเลือกว่าหารกับใคร แอปจะคำนวณว่าใครต้องโอนให้ใครเท่าไหร่
พร้อม PromptPay QR สำหรับสแกนจ่าย

ตัวแอปเป็น PWA (Vite + React) ใช้ Supabase เป็นหลังบ้าน (ฐานข้อมูล, login, เก็บรูป, realtime, edge functions)
และใช้ Gemini API แบบ free tier ทุกส่วนใช้แบบฟรีได้

```
src/money.ts          คณิตทั้งหมด: หารตามรายการ, SC/VAT, ปัดเศษ, ยอดค้าง, simplify  (test: npx vitest)
src/*.tsx             หน้าจอ
supabase/migrations   schema + RLS  → วางใน SQL Editor
supabase/functions    scan-receipt (Gemini), notify (push)
```

## ตั้งค่าครั้งแรก

### 1. Supabase
1. สร้าง project ที่ [supabase.com](https://supabase.com) (เลือก region Singapore)
2. ไปที่ **SQL Editor** แล้ววางเนื้อหาไฟล์ `supabase/migrations/20261012000000_init.sql` แล้วกด Run
3. ไปที่ **Authentication → Sign In / Providers → Google** แล้วเปิดใช้
   - สร้าง OAuth Client (Web application) ที่ [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   - ช่อง Authorized redirect URI ให้ใส่ `https://<project-ref>.supabase.co/auth/v1/callback`
   - นำ Client ID และ Secret มาใส่ใน Supabase
4. ไปที่ **Authentication → URL Configuration** แล้วตั้งค่า
   - Site URL: `https://<ชื่อแอป>.pages.dev`
   - Redirect URLs: `http://localhost:5188/**` และ `https://<ชื่อแอป>.pages.dev/**`
5. ไปที่ **Project Settings → API** คัดลอก URL และ anon (publishable) key ไปใส่ใน `.env.local`

### 2. Gemini (อ่านใบเสร็จ)
1. ขอ API key ที่ [aistudio.google.com](https://aistudio.google.com/apikey)
2. รันคำสั่งต่อไปนี้
   ```bash
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase secrets set GEMINI_API_KEY=<key>
   npx supabase functions deploy scan-receipt
   ```
3. ถ้ารุ่น Flash-Lite ที่ใช้เป็นค่าเริ่มต้นอ่านใบเสร็จไม่แม่น ให้ตั้ง `GEMINI_MODEL` เป็นรุ่นอื่น เช่น `npx supabase secrets set GEMINI_MODEL=gemini-flash-latest`
   แต่ละรุ่นมีโควต้าฟรีไม่เท่ากัน ดูได้ที่ AI Studio → Rate limits

### 3. ขึ้นเว็บ (Cloudflare Pages)
1. push โปรเจกต์ขึ้น GitHub
2. ที่ Cloudflare Pages ให้เชื่อม repo แล้วตั้งค่า
   - Build command: `npm run build`
   - Output directory: `dist`
   - Environment variables: ใส่ทุกตัวที่ขึ้นต้นด้วย `VITE_` แบบเดียวกับใน `.env.local`

### 4. Push notification (ไม่บังคับ)
1. สร้าง VAPID keys
   ```bash
   npx web-push generate-vapid-keys
   ```
2. ใส่ public key เป็น `VITE_VAPID_PUBLIC_KEY` ทั้งใน `.env.local` และใน Cloudflare
3. ตั้ง secrets แล้ว deploy function
   ```bash
   npx supabase secrets set VAPID_PUBLIC_KEY=<pub> VAPID_PRIVATE_KEY=<priv> VAPID_SUBJECT=mailto:<อีเมลคุณ> NOTIFY_SECRET=<สุ่มยาวๆ>
   npx supabase functions deploy notify --no-verify-jwt
   ```
4. ไปที่ **Database → Webhooks** แล้วสร้าง 2 อัน คือ `bills` INSERT และ `comments` INSERT
   - ประเภทเลือก Supabase Edge Functions → `notify`
   - เพิ่ม HTTP header `x-notify-secret: <NOTIFY_SECRET>`
5. ถ้าเพื่อนใช้ iPhone ต้องเป็น iOS 16.4 ขึ้นไป และต้อง Add to Home Screen แล้วเปิดแอปจากไอคอนก่อน ถึงจะกดเปิดแจ้งเตือนได้

### 5. กันโปรเจกต์หลับ
Supabase แบบฟรีจะหยุดโปรเจกต์ถ้าไม่มีใครใช้ 7 วัน
ให้ไปที่ GitHub repo → Settings → Secrets แล้วใส่ `SUPABASE_URL` กับ `SUPABASE_ANON_KEY`
จากนั้น `.github/workflows/keepalive.yml` จะส่งคำขอไปปลุกทุก 3 วัน

## พัฒนาต่อ
```bash
npm run dev        # http://localhost:5188 (ต้องตรงกับ Redirect URLs ใน Supabase)
npx vitest
npm run build
```

## ใช้งาน
1. สร้างกลุ่ม แล้วกด "แชร์ลิงก์เชิญ" ส่งเข้า LINE ให้เพื่อน
2. ถ้ามีเพื่อนที่ไม่ใช้แอป ให้เพิ่มเป็นสมาชิกแบบ guest แล้วติ๊กรายการแทนเขา
3. กด "สแกนใบเสร็จ" แล้วตรวจรายการกับยอดให้ตรงกับใบจริง ถ้ามีคำเตือนสีแดงแปลว่ายอดไม่ตรง จากนั้นกดโพสต์
4. เปิดบิลแล้วแตะรายการที่เป็นของตัวเอง ถ้าหารกับคนอื่นให้กด 👥 แล้วเลือกคน (ใส่จำนวนส่วนได้ เช่น ×2)
5. ดูตาราง "แต่ละคนจ่าย" แล้วสแกน PromptPay QR จ่ายคนที่ออกเงินให้ จากนั้นกด "บันทึกว่าโอนแล้ว" และแนบสลิปได้

รายการที่ยังไม่มีใครเลือก จะนับว่าคนจ่ายออกเงินส่วนนั้นเองจนกว่าจะมีคนมาติ๊ก
ยอดเงินแยกตามสกุลเงิน ไม่มีการแปลงเรท
