// Manual "send test email" (run by the Send test email workflow).
import { sendMail } from './email.js';

const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
await sendMail({
  subject: 'Arb Scanner: test email ✔',
  text: `This is a test from your arbitrage dashboard, sent ${now} ET.\n\nIf you're reading this, Gmail SMTP and your GitHub Secrets are set up correctly. Real alerts will look similar and arrive at most ${5} times a day.\n\nNot financial advice.`,
  html: `<div style="font-family:system-ui,sans-serif"><h2>Test email ✔</h2><p>Sent ${now} ET from your arbitrage dashboard.</p><p>Gmail SMTP and your GitHub Secrets are set up correctly. Real alerts will arrive at most 5 times a day.</p>${process.env.DASHBOARD_URL ? `<p><a href="${process.env.DASHBOARD_URL}">Open the dashboard</a></p>` : ''}<p style="color:#777;font-size:12px">Not financial advice.</p></div>`,
});
console.log('Test email sent.');
