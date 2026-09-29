// WhatsApp notifications via Meta WhatsApp Cloud API.
// If the env vars below are NOT set, this silently does nothing (app keeps working).
//   WHATSAPP_TOKEN, WHATSAPP_PHONE_ID
//   WHATSAPP_TEMPLATE_OWNER    (default: salonwale_owner_update)
//   WHATSAPP_TEMPLATE_CUSTOMER (default: salonwale_customer_update)
// Both templates take 2 variables: {{1}} = person's name, {{2}} = the message line.

function enabled() {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);
}

async function send(phone10, template, name, line) {
  if (!enabled()) return;
  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: `91${phone10}`,
        type: "template",
        template: {
          name: template,
          language: { code: process.env.WHATSAPP_LANG || "en" },
          components: [{
            type: "body",
            parameters: [
              { type: "text", text: String(name || "there").slice(0, 60) },
              { type: "text", text: String(line).replace(/\s+/g, " ").slice(0, 300) },
            ],
          }],
        },
      }),
    });
    if (!res.ok) console.error("WhatsApp send failed:", res.status, await res.text());
  } catch (err) {
    console.error("WhatsApp error:", err.message); // never break the booking because of a message
  }
}

const notifyOwner = (phone, name, line) =>
  send(phone, process.env.WHATSAPP_TEMPLATE_OWNER || "salonwale_owner_update", name, line);
const notifyCustomer = (phone, name, line) =>
  send(phone, process.env.WHATSAPP_TEMPLATE_CUSTOMER || "salonwale_customer_update", name, line);

function when(date) {
  return new Date(date).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
  });
}

module.exports = { notifyOwner, notifyCustomer, when, enabled };
