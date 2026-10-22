// Event fields come from other services (and some were typed by patients) -
// escape before they go into an HTML email body.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// "person@example.com" -> "p***@example.com". Recipient addresses are personal
// data; logs only need enough to correlate with a support ticket.
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${address[0]}***${address.slice(at)}`;
}
