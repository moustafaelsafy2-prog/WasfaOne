<!-- login.js -->
<script>
(function () {
  "use strict";

  let form, emailInp, passInp, errBox, submitBtn;

  function $(sel) { return document.querySelector(sel); }
  function showErr(msg) {
    errBox.textContent = msg || "";
    errBox.classList.toggle("hidden", !msg);
  }
  function uuidv4() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0, v = c === "x" ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
  function isoDateOnly(d = new Date()) { return d.toISOString().slice(0, 10); }
  function withinRange(start, end) {
    const today = isoDateOnly();
    return (!start || today >= start) && (!end || today <= end);
  }

  async function handleLogin(ev) {
    ev.preventDefault();
    showErr("");

    // تحذير عند التشغيل بملف محلي file:// (fetch لن يعمل)
    if (location.protocol === "file:") {
      showErr("شغّل الموقع عبر خادم محلي/Netlify — فتح الملف مباشرة سيمنع قراءة users.json");
      return;
    }

    const email = (emailInp.value || "").trim().toLowerCase();
    const password = (passInp.value || "").trim();

    if (!email || !password) {
      showErr("الرجاء إدخال البريد الإلكتروني وكلمة المرور");
      return;
    }

    submitBtn.disabled = true;

    try {
      const res = await fetch("./users.json", { cache: "no-store" });
      if (!res.ok) throw new Error("تعذر تحميل قائمة المستخدمين");
      const users = await res.json();

      const user = (users || []).find(u =>
        (u.email || "").toLowerCase() === email &&
        String(u.password || "") === password
      );

      if (!user) { showErr("بيانات الدخول غير صحيحة"); return; }
      if (user.status && user.status !== "active") { showErr("الحساب غير نشط"); return; }
      if (!withinRange(user.start_date, user.end_date)) {
        showErr("انتهت صلاحية الوصول أو لم تبدأ بعد"); return;
      }

      // إعداد بيانات الجلسة
      const session = {
        email: user.email,
        name: user.name || "",
        auth_token: user.auth_token || uuidv4(),
        session_nonce: user.session_nonce || uuidv4(),
        start_date: user.start_date || null,
        end_date: user.end_date || null,
        login_at: new Date().toISOString()
      };
      localStorage.setItem("wasfa_session", JSON.stringify(session));

      // تحويل إلى التطبيق
      window.location.href = "app.html";
    } catch (e) {
      showErr(e.message || "تعذر إتمام تسجيل الدخول");
    } finally {
      submitBtn.disabled = false;
    }
  }

  function boot() {
    form = $("#login-form");
    emailInp = $("#email");
    passInp = $("#password");
    errBox = $("#login-error");
    submitBtn = form ? form.querySelector("button[type=submit]") : null;

    if (!form || !emailInp || !passInp || !errBox || !submitBtn) {
      console.error("Login page elements missing.");
      return;
    }
    form.addEventListener("submit", handleLogin);
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
</script>
