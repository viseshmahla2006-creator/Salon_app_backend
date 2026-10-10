// Email OTP via Brevo (https://www.brevo.com) transactional email API.
// Render's free tier blocks outbound SMTP connections (which is why Gmail SMTP
// times out), so this uses Brevo's HTTPS API instead — same kind of HTTPS call
// the WhatsApp integration already makes, so it works fine on Render.
// Needs env vars: BREVO_API_KEY, SENDER_EMAIL (see EMAIL_SETUP.md)

function configured() {
  return !!(process.env.BREVO_API_KEY && process.env.SENDER_EMAIL);
}

async function sendOtpEmail(toEmail, otp) {
  if (!configured()) throw new Error("Email OTP is not set up yet");
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": process.env.BREVO_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender: { name: "SalonWale", email: process.env.SENDER_EMAIL },
      to: [{ email: toEmail }],
      subject: `${otp} is your SalonWale verification code`,
      textContent: `Your SalonWale verification code is ${otp}. It is valid for 10 minutes. Do not share this code with anyone.`,
      htmlContent: `
        <div style="font-family:sans-serif; max-width:420px; margin:0 auto;">
          <h2 style="color:#111;">SalonWale</h2>
          <p>Your verification code is:</p>
          <p style="font-size:30px; font-weight:700; letter-spacing:6px; color:#e5a63c;">${otp}</p>
          <p style="color:#555; font-size:13px;">This code is valid for 10 minutes. Do not share it with anyone.</p>
        </div>`,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("Brevo send failed:", res.status, errText);
    throw new Error("Couldn't send the email, please try again");
  }
}

module.exports = { sendOtpEmail, configured };
