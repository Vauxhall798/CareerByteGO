require('dotenv').config();
const dns = require('dns');
if (dns && dns.setDefaultResultOrder) dns.setDefaultResultOrder('ipv4first');
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Port and base URL (use deployed URL by default or override with BASE_URL)
const PORT = process.env.PORT || 3001;
const BASE_URL = process.env.BASE_URL || 'https://careerbytego.onrender.com';

// Hardcoded admin email
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@careerbytecode.com';

// Note: transporter is created at send-time so we can support OAuth2 or password auth dynamically.

// Helper: try sending email with password auth using common SMTP configs (465 then 587)
async function sendMailWithPassword(mailOptions) {
  const smtpConfigs = [
    { host: 'smtp.gmail.com', port: 465, secure: true },
    { host: 'smtp.gmail.com', port: 587, secure: false }
  ];

  for (const cfg of smtpConfigs) {
    try {
      const transporter = nodemailer.createTransport(Object.assign({}, cfg, {
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
        // timeouts to fail fast on blocked ports
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 10000,
        pool: false
      }));

      // verify before sending to catch connection issues early
      await transporter.verify();
      await transporter.sendMail(mailOptions);
      console.log(`✅ Password email sent using ${cfg.host}:${cfg.port}`);
      return true;
    } catch (err) {
      console.error(`Password email send attempt failed (${cfg.host}:${cfg.port}):`, err && err.message ? err.message : err);
      // continue to next config
    }
  }
  return false;
}

// Helper: send email using SendGrid API
async function sendMailWithSendGrid(mailOptions) {
  try {
    const key = process.env.SENDGRID_API_KEY;
    if (!key) return false;
    sgMail.setApiKey(key);
    const msg = {
      to: mailOptions.to.split(',').map(s => s.trim()),
      from: mailOptions.from.replace(/^"?[^<]*"?\s*<([^>]+)>$/, '$1'),
      subject: mailOptions.subject,
      html: mailOptions.html
    };
    await sgMail.send(msg);
    console.log('✅ Email sent via SendGrid');
    return true;
  } catch (err) {
    console.error('SendGrid send error:', err && err.message ? err.message : err);
    return false;
  }
}

// Configure OAuth2 client (redirect URI uses BASE_URL)
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${BASE_URL}/oauth2callback`
);

// Load refresh token from env if available
if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
}

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// ─── OAuth2 Authorization Route ──────────────────────────────────────────────
// Visit <BASE_URL>/auth to start the one-time authorization flow
app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar']
  });
  res.redirect(url);
});

// OAuth2 Callback – captures the refresh token and prints it to the console
app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Authorization code missing.');
  }
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    console.log('\n✅ Authorization successful!');
    console.log('───────────────────────────────────────────────');
    console.log('Add the following to your .env file:\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('───────────────────────────────────────────────\n');
      // Persist refresh token into .env so server restarts pick it up
      if (tokens.refresh_token) {
        try {
          const envPath = path.join(__dirname, '.env');
          let envContents = '';
          if (fs.existsSync(envPath)) {
            envContents = fs.readFileSync(envPath, 'utf8');
          }
          const key = 'GOOGLE_REFRESH_TOKEN';
          const newLine = `${key}=${tokens.refresh_token}`;
          if (envContents.includes(`${key}=`)) {
            // replace existing line
            envContents = envContents.replace(new RegExp(`${key}=.*`), newLine);
          } else {
            if (envContents.length && envContents[envContents.length - 1] !== '\n') envContents += '\n';
            envContents += newLine + '\n';
          }
          fs.writeFileSync(envPath, envContents, 'utf8');
          console.log('✅ Wrote GOOGLE_REFRESH_TOKEN to .env');
        } catch (err) {
          console.error('Failed to persist refresh token to .env:', err && err.message ? err.message : err);
        }
      }
    res.send(`
      <h2>✅ Authorization Successful!</h2>
      <p>Check your <strong>terminal</strong> for the GOOGLE_REFRESH_TOKEN value.</p>
      <p>Copy it into your <code>.env</code> file, then restart the server.</p>
    `);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send('Failed to get tokens: ' + err.message);
  }
});

// ─── Book Session Endpoint ────────────────────────────────────────────────────
app.post('/api/book-session', async (req, res) => {
  const { mentorId, mentorName, slotDate, userEmail } = req.body;

  if (!userEmail) {
    return res.status(400).json({ error: 'User email is required' });
  }

  let meetLink = 'Meeting link will be provided shortly.';
  const eventSummary = `Mentorship Session: ${mentorName}`;

  try {
    if (process.env.GOOGLE_REFRESH_TOKEN) {
      // Real Google Calendar + Meet event
      const startTime = new Date(slotDate);
      const endTime = new Date(startTime.getTime() + 30 * 60000);

      const event = {
        summary: eventSummary,
        description: `1:1 Mentorship session with ${mentorName}`,
        start: { dateTime: startTime.toISOString(), timeZone: 'Asia/Kolkata' },
        end: { dateTime: endTime.toISOString(), timeZone: 'Asia/Kolkata' },
        conferenceData: {
          createRequest: {
            requestId: crypto.randomUUID(),
            conferenceSolutionKey: { type: 'hangoutsMeet' }
          }
        },
        attendees: [
          { email: userEmail },
          { email: ADMIN_EMAIL }
        ]
      };

      try {
        const response = await calendar.events.insert({
          calendarId: 'primary',
          resource: event,
          conferenceDataVersion: 1,
          sendUpdates: 'all'
        });
        meetLink = response.data.hangoutLink || response.data.htmlLink || meetLink;
        console.log('Google Calendar event created:', response.data.htmlLink);
      } catch (calendarError) {
        // Log detailed calendar error
        try {
          console.error('Google Calendar API Error:', calendarError);
          if (calendarError && calendarError.response && calendarError.response.data) {
            console.error('Calendar API response:', calendarError.response.data);
          }
        } catch (e) {
          console.error('Error logging calendar error:', e && e.message ? e.message : e);
        }

        // If refresh token is invalid/revoked, remove it from .env and prompt re-auth
        const errMsg = (calendarError && (calendarError.message || (calendarError.response && calendarError.response.data && calendarError.response.data.error_description) || JSON.stringify(calendarError))) || '';
        if (errMsg.toLowerCase().includes('invalid_grant') || errMsg.toLowerCase().includes('invalid_grant')) {
          try {
            const envPath = path.join(__dirname, '.env');
            if (fs.existsSync(envPath)) {
              let envContents = fs.readFileSync(envPath, 'utf8');
              if (envContents.includes('GOOGLE_REFRESH_TOKEN=')) {
                // remove the line
                envContents = envContents.replace(/\n?GOOGLE_REFRESH_TOKEN=.*(?:\n|$)/, '\n');
                fs.writeFileSync(envPath, envContents, 'utf8');
                console.log('Removed invalid GOOGLE_REFRESH_TOKEN from .env — please re-authorize at /auth');
              }
            }
          } catch (envErr) {
            console.error('Failed to remove invalid refresh token from .env:', envErr && envErr.message ? envErr.message : envErr);
          }
          // clear credentials in memory
          oauth2Client.setCredentials({});
        }

        meetLink = `https://meet.google.com/fallback-${crypto.randomUUID().substring(0, 8)}`;
      }
    } else {
      console.log('No GOOGLE_REFRESH_TOKEN found. Using mock link.');
      console.log(`Visit ${BASE_URL}/auth to authorize Google Calendar.`);
      meetLink = `https://meet.google.com/mock-${crypto.randomUUID().substring(0, 8)}`;
    }

    // Prepare confirmation email (send asynchronously so booking response is fast)
    const mailOptions = {
      from: `"CareerByteCode" <${process.env.EMAIL_USER}>`,
      to: [userEmail, ADMIN_EMAIL].join(', '),
      subject: `✅ Confirmed: ${eventSummary}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:auto">
          <h2 style="color:#6366f1">Mentorship Session Confirmed 🎉</h2>
          <p>Your session with <strong>${mentorName}</strong> has been successfully booked.</p>
          <table style="width:100%;border-collapse:collapse;margin:20px 0">
            <tr><td style="padding:8px;color:#666">Mentor</td><td style="padding:8px"><strong>${mentorName}</strong></td></tr>
            <tr><td style="padding:8px;color:#666">Time</td><td style="padding:8px"><strong>${new Date(slotDate).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</strong></td></tr>
            <tr><td style="padding:8px;color:#666">Google Meet</td><td style="padding:8px"><a href="${meetLink}" style="color:#6366f1">${meetLink}</a></td></tr>
          </table>
          <p style="color:#888;font-size:13px">Thank you for booking with CareerByteCode!</p>
        </div>
      `
    };

    // Fire-and-forget email sending so frontend receives response immediately.
    (async function sendConfirmationEmails(opts) {
      try {
        console.log('🔔 Background: starting email send attempts');
        let emailSent = false;

        if (process.env.SENDGRID_API_KEY) {
          try {
            const ok = await sendMailWithSendGrid(opts);
            if (ok) {
              emailSent = true;
              console.log('Background: sent via SendGrid');
            }
          } catch (e) {
            console.error('SendGrid attempt error (background):', e && e.message ? e.message : e);
          }
        }

        if (!emailSent && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
          try {
            const ok = await sendMailWithPassword(opts);
            if (ok) {
              emailSent = true;
              console.log('Background: sent via SMTP (password)');
            } else {
              console.error('Background: password email send failed on all SMTP attempts');
            }
          } catch (emailError) {
            console.error('Background: Password email send error:', emailError && emailError.message ? emailError.message : emailError);
          }
        }

        if (!emailSent && process.env.GOOGLE_REFRESH_TOKEN && process.env.EMAIL_USER && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
          try {
            const accessTokenObj = await oauth2Client.getAccessToken();
            const accessToken = accessTokenObj && accessTokenObj.token ? accessTokenObj.token : accessTokenObj;
            const oauthTransporter = nodemailer.createTransport({
              service: 'gmail',
              auth: {
                type: 'OAuth2',
                user: process.env.EMAIL_USER,
                clientId: process.env.GOOGLE_CLIENT_ID,
                clientSecret: process.env.GOOGLE_CLIENT_SECRET,
                refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
                accessToken
              },
              connectionTimeout: 10000,
              greetingTimeout: 5000,
              socketTimeout: 10000
            });
            await oauthTransporter.sendMail(opts);
            emailSent = true;
            console.log('Background: sent via OAuth2');
          } catch (emailError) {
            console.error('Background: OAuth2 email send error:', emailError && emailError.message ? emailError.message : emailError);
          }
        }

        if (!emailSent) {
          console.log('Background: No email credentials or all email methods failed. Would have sent to:', opts.to);
          console.log('Background: Meet Link:', opts.html && opts.html.includes('href') ? 'present' : 'unknown');
        }
      } catch (bgErr) {
        console.error('Background email worker error:', bgErr && bgErr.message ? bgErr.message : bgErr);
      }
    })(mailOptions).catch(err => console.error('Failed to start background email sender:', err));

    // Return success immediately after calendar creation/fallback
    res.json({ success: true, meetLink });

  } catch (error) {
    console.error('Error booking session:', error);
    res.status(500).json({ error: 'Failed to process booking' });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Server running on ${BASE_URL} (local port ${PORT})`);
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    console.log(`\n⚠️  Google Calendar not authorized yet.`);
    console.log(`   → Open ${BASE_URL}/auth in your browser to authorize.\n`);
  } else {
    console.log('✅ Google Calendar authorized.\n');
  }
});
