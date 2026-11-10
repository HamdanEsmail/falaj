// Calls POST /api/admin/monitors-init. The admin token comes from the
// environment (never from a secrets file in this script).
const base = (process.argv[2] ?? process.env.PUBLIC_BASE_URL ?? "http://localhost:8787").replace(/\/$/, "");
const token = process.env.ADMIN_TOKEN;
if (!token) {
  console.error("ADMIN_TOKEN is required");
  process.exit(1);
}
const res = await fetch(`${base}/api/admin/monitors-init`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
});
const text = await res.text();
console.log(res.status, text);
if (!res.ok) process.exit(1);
