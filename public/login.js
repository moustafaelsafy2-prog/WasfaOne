const r = await fetch("/.netlify/functions/login", {
  method:"POST",
  headers:{"Content-Type":"application/json"},
  body: JSON.stringify({ email, password, device_fingerprint: fingerprint })
});
