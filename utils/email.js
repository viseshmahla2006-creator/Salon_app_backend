// Email OTP via Gmail SMTP (nodemailer). Needs these env vars on Render:
//   EMAIL_USER           — the Gmail address to send from, e.g. salonwale2@gmail.com
//   EMAIL_APP_PASSWORD   — a 16-character Gmail "App Password" (NOT your normal Gmail password)
// See EMAIL_SETUP.md for how to create an App Password.

const nodemailer = require("nodemailer");

function configured() {
  return !!(process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD);
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD },
    });
  }
  return transporter;
}

async function sendOtpEmail(toEmail, otp) {
  if (!configured()) throw new Error("Email OTP is not set up yet");
  try {
    await getTransporter().sendMail({
      from: `"SalonWale" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: `${otp} is your SalonWale verification code`,
      text: `Your SalonWale verification code is ${otp}. It is valid for 10 minutes. Do not share this code with anyone.`,
      html: `
        <div style="font-family:sans-serif; max-width:420px; margin:0 auto;">
          <h2 style="color:#111;">SalonWale</h2>
          <p>Your verification code is:</p>
          <p style="font-size:30px; font-weight:700; letter-spacing:6px; color:#e5a63c;">${otp}</p>
          <p style="color:#555; font-size:13px;">This code is valid for 10 minutes. Do not share it with anyone.</p>
        </div>`,
    });
  } catch (err) {
    console.error("Email send failed:", err.message);
    throw new Error("Couldn't send the email, please try again");
  }
}

module.exports = { sendOtpEmail, configured };
