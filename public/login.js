// /public/login.js
// WasfaOne — Login (frontend)
// يعتمد على Netlify Function: /.netlify/functions/login
// يُخزّن الجلسة في localStorage باسم "wasfa_session" ثم يوجّه إلى app.html

(function () {
  "use strict";

  // ===== عناصر الواجهة =====
  let form, emailInp, passInp, errBox, submitBtn;

  // ===== أدوات مساعدة =====
  const $ = (sel) => document.querySelector(sel);

  function showErr(msg) {
    errBox.textContent = msg || "";
    errBox.classList.toggle("hidden", !msg);
  }

  // تحذير: فتح عبر file:// يعطل fetch
  function ensureHttpServing() {
    if (location.protocol === "file:") {
      showErr("رجاءً شغّل الموقع عبر خادم (Netlify أو خادم محلي). فتح الملف مباشرة يمنع الاتصال بالخادم.");
      return false;
    }
    return true;
  }

  // توليد/قراءة معرّف جهاز ثابت
  function getOrCreateDeviceId() {
    let id = localStorage.getItem("wasfa_device_id");
    if (!id && crypto.randomUUID) {
      id = crypto.randomUUID();
      localStorage.setItem("wasfa_device_id", id);
    }
    if (!id) {
      id = String(Math.random()).slice(2);
      localStorage.setItem("wasfa_device_id", id);
    }
    return id;
  }

  // حساب SHA-256 (hex) لسلسلة
  async function sha256Hex(str) {
    const data = new TextEncoder().encode(str);
    const hashBuf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // بصمة جهاز مبسّطة + تجزئة
  async function computeDeviceFingerprintHash() {
    const deviceId = getOrCreateDeviceId();
    const parts = [
      navigator.userAgent,
      navigator.language,
      `${screen.width}x${screen.height}`,
      screen.colorDepth,
      new Date().getTimezoneOffset(),
      navigator.platform,
      navigator.hardwareConcurrency || 0,
      deviceId,
    ].join("|");
    return sha256Hex(parts);
  }

  // تخزين الجلسة
  function saveSession(data, fpHash) {
    const session = {
      email: data.email,
      name: data.name || "",
      auth_token: data.token,
      session_nonce: data.session_nonce,
      device_fingerprint: fpHash,
      login_at: new Date().toISOString(),
    };
    localStorage.setItem("wasfa_session", JSON.stringify(session));
  }

  // نداء الـ Function
  async function callLogin(email, password, fpHash) {
    const r = await fetch("/.netlify/functions/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        device_fingerprint_hash: fpHash,
      }),
    }).catch(() => null);

    if (!r) throw new Error("تعذر الاتصال بالخادم");
    let data = null;
    try {
      data = await r.json();
    } catch (_) {
      data = null;
    }

    if (!r.ok || !data) {
      throw new Error(`نأسف حيث هذا الحساب مرتبط بجهاز أخر (${r?.status || "?"})`);
    }
    if (!data.ok) {
      // خرائط رسائل الخطأ الشائعة من Function
      switch (data.reason) {
        case "invalid":
          throw new Error("بيانات الدخول غير صحيحة");
        case "inactive":
          throw new Error("الحساب غير نشط أو خارج فترة الاشتراك");
        case "device_locked":
        case "device":
          throw new Error(data.message || "الحساب مرتبط بجهاز آخر");
        case "missing_fields":
          throw new Error("حقول ناقصة: البريد/كلمة المرور/بصمة الجهاز");
        default:
          throw new Error(data.message || "فشل تسجيل الدخول");
      }
    }
    return data;
  }

  // معالج الإرسال
  async function handleLogin(ev) {
    ev.preventDefault();
    showErr("");

    if (!ensureHttpServing()) return;

    const email = (emailInp.value || "").trim().toLowerCase();
    const password = (passInp.value || "").trim();

    if (!email || !password) {
      showErr("الرجاء إدخال البريد الإلكتروني وكلمة المرور");
      return;
    }

    submitBtn.disabled = true;

    try {
      const fpHash = await computeDeviceFingerprintHash();
      const data = await callLogin(email, password, fpHash);
      saveSession(data, fpHash);
      // تحويل إلى التطبيق
      window.location.href = "app.html";
    } catch (e) {
      showErr(e.message || "تعذر إتمام تسجيل الدخول");
    } finally {
      submitBtn.disabled = false;
    }
  }

  // تهيئة الصفحة
  function boot() {
    form = $("#login-form");
    emailInp = $("#email");
    passInp = $("#password");
    errBox = $("#login-error");
    submitBtn = form ? form.querySelector('button[type="submit"]') : null;

    if (!form || !emailInp || !passInp || !errBox || !submitBtn) {
      console.error("Login page elements missing.");
      showErr("خطأ في عناصر الصفحة. تأكد من معرفات الحقول والأزرار.");
      return;
    }

    form.addEventListener("submit", handleLogin);
  }

  document.addEventListener("DOMContentLoaded", boot);
})();

