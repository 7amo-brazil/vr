# 🚂 Deployment Guide — Railway (A → Z)

> ليش Railway مثالية لهذا المشروع؟
> لأن Railway تشغّل **عملية مستمرة 24/7** (مش serverless مثل Vercel) — يعني محرك الـ keep-alive
> بيشتغل أصلاً من غير أي تعديل. المشروع مصمم من البداية يقبل كل متغيرات Railway (PORT تلقائي،
> و`DATA_DIR` للتخزين الدائم).

---

## أولاً: الحساب والتكلفة

| المرحلة | التكلفة |
|---|---|
| Trial | **$5 رصيد مجاني — 30 يوم — بدون بطاقة** (للتجربة الكاملة) |
| Hobby | $5/شهر **تشمل $5 استخدام** — تطبيقك الصغير بيستهلك ~$1–2/شهر يعني **$5/شهر إجمالي** |

> 💡 تحب مجاني للأبد؟ استخدم VM مجاني من Oracle Cloud (شوف README.md). Railway أنظف وأسرع لكن مدفوعة بعد التجربة.

## ثانياً: الرفع من GitHub (الأسهل — موصى به)

### 1) حط المشروع على GitHub
```bash
cd discord-vr-status-forever
git init
git add .
git commit -m "VR Status LUX v5.0.0 — 7amo Brazil"
# أنشئ repo جديد من github.com (مثلاً vr-status-lux) ثم:
git remote add origin https://github.com/USERNAME/vr-status-lux.git
git push -u origin main
```
(أو بدون git: من صفحة الـ repo اختر **Add file → Upload files** واسحب الملفات.)

### 2) أنشئ حساب Railway
- روح [railway.com](https://railway.com) → **Sign up with GitHub**.
- رح يطلعلك رصيد $5 مجاني تلقائياً (بدون بطاقة).

### 3) أنشئ المشروع
- **New Project** → **Deploy from GitHub repo** → اختر `vr-status-lux`.
- Railway (Nixpacks) بتكتشف Node.js تلقائياً من `package.json`،
  و`railway.json` المرفوع بيفرض أمر التشغيل `node server.js` مع **restartPolicy: ALWAYS**.
- اضغط **Deploy** واستنى 30–60 ثانية → الحالة تصير **Running** ✅

### 4) متغيرات البيئة (ضروري!)
من صفحة الـ service → تبويب **Variables** → **New Variable**:

| Name | Value |
|---|---|
| `ADMIN_PASSWORD` | كلمة مرور قوية (10+ أحرف — المشروع بيرفض الأضعف) |

(اختياري: `KEEPALIVE_MS` — الافتراضي 60000 يكفي.)

### 5) رابط الموقع
- تبويب **Networking** → **Generate Domain** → بياخدلك `https://xxxx.up.railway.app` (HTTPS تلقائي).
- افتحه → الموقع شغال 🎉
- `/admin` لوحة الأدمن • `/me` حساب الزبون • `/healthz` فحص.

### 6) التخزين الدائم (Volume) — سر "للأبد" ⚠️
**مهم:** نظام ملفات Railway **مؤقت** — بدون Volume، أي redeploy أو restart بيمسح `data/`
(الحسابات وبتذوب). الحل (دقيقتين):
1. من صفحة الـ service → **Settings → Volumes → Add Volume**.
2. اختر mount path: **`/data`** (سعة 10GB تكفي آلاف الحسابات).
3. في **Variables** أضف: `DATA_DIR` = `/data`
4. بيسوي Railway redeploy تلقائي — وكل شي بيصير محفوظ للأبد بعد أي restart/deploy.

### 7) دومينك الخاص (اختياري)
**Networking → Custom Domain** (خطة Hobby) → اربط دومينك وبيشغل DNS تلقائياً.

### 8) اللوجات والمراقبة
- لوحة Railway: **View Logs** (نفس فكرة journalctl) — بتشوف `[engine] token refreshed` وheartbeat وكل حدث.
- **Metrics**: RAM/CPU لحظي.

## ثالثاً: الرفع بـ CLI (بدون GitHub)
```bash
npm i -g @railway/cli
railway login                  # بتفتح المتصفح
cd discord-vr-status-forever
railway init                   # ينشئ project محلي
railway variables set ADMIN_PASSWORD="YourStrongPass123!"
railway up                     # بيدرج الملفات وينشر
railway domain                 # يولّد رابط عام
```
(نفس خطوة الـ Volume من اللوحة بعد النشر.)

## رابعاً: بعد النشر — قائمة التحقق

- [ ] `https://your-domain/healthz` يرجع `{"ok":true}`
- [ ] الموقع بيتفتح والتصميم البنفسجي ظاهر
- [ ] `/admin` بيسألك كلمة المرور (جرب غلط 5 مرات → بيقفل 15 دقيقة — هاد الأمان شغال)
- [ ] شغّل شارة تجريبية من الموقع وتأكد إنها تظهر بـ `/admin`
- [ ] Volume مربوط بـ `/data` و`DATA_DIR` مضبوط
- [ ] من `/admin` شوف الـ Audit log — كل حدث مسجل

## خامساً: التكلفة المتوقعة لتطبيقك
| البند | التقدير الشهري |
|---|---|
| RAM (~60–150MB شغالة 24/7) | ~$0.6–1.5 |
| CPU (خامل تقريباً) | ~$0.2–0.5 |
| Volume 10GB | ~$1.5 |
| **الإجمالي** | **ضمن الـ $5/شهر (Hobby)** |

## سادساً: ملاحظات ختامية
- Railway بترسل `PORT` تلقائياً والسيرفر بياخذه (`process.env.PORT`) — **ما بتغير أي شي بالكود**.
- لو التطبيق انقلب → **ALWAYS restart** بيفضل يرفعه لحاله (مثل systemd).
- ورا HTTPS بـ Railway → HSTS بيتفعّل تلقائياً.
- لإيقاف التكلفة: **Pause** للـ service من اللوحة.
