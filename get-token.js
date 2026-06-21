require('dotenv').config();
const { google } = require('googleapis');

const BASE_URL = process.env.BASE_URL || 'https://careerbytego.onrender.com';
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${BASE_URL}/oauth2callback`
);

const url = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/calendar']
});

console.log('\n📋 Copy this URL and open it in your browser:\n');
console.log(url);
console.log(`\nAfter authorizing, you will be redirected to ${BASE_URL} (which may show an error page).`);
console.log('Copy the "code" parameter from the URL and paste it below.\n');

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Paste the authorization code here: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    console.log('\n✅ Success! Here is your refresh token:\n');
    console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
    console.log('\nAdd the above line to your .env file and restart the server.\n');
  } catch (err) {
    console.error('\n❌ Error getting token:', err.message);
  }
});
