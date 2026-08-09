const { readFileSync } = require('node:fs');
const admin = require('firebase-admin');
const key = JSON.parse(readFileSync('C:\\Users\\Ernur\\AppData\\Local\\Temp\\opencode\\svc.json', 'utf8'));
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(key) });

(async () => {
  const state = await admin.firestore().collection('system').doc('relay_state').get();
  console.log('relay_state exists:', state.exists);
  if (state.exists) {
    const d = state.data();
    console.log('cursor time:', new Date(d.cursorMs).toISOString(), '| updatedAt:', d.updatedAt?.toDate?.().toISOString() ?? '?');
  }
  console.log('NOW:', new Date().toISOString());
  const u = (await admin.firestore().collection('users').where('nickname', '==', 'Ernur').limit(1).get()).docs[0];
  console.log('Ernur fcmTokens:', (u.data().fcmTokens || []).length);
  process.exit(0);
})().catch(e => { console.error('FIRESTORE QUOTA:', e.message); process.exit(1); });