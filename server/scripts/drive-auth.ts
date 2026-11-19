// Obtient le jeton de renouvellement Google Drive (à faire une seule fois).
// Flux « appareil » : adapté au téléphone et à Termux (pas de navigateur local ni d'adresse de retour).
//
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run drive:auth -w server
//
// Le client OAuth doit être de type « Téléviseurs et appareils à saisie limitée ».
const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Définissez GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET (voir docs/stockage-google-drive.md).');
  process.exit(1);
}

// Portée minimale : l'application ne voit que les fichiers qu'elle a elle-même créés, jamais le reste du Drive.
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const form = (o: Record<string, string>) => new URLSearchParams(o);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const start = await fetch('https://oauth2.googleapis.com/device/code', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: form({ client_id: clientId, scope: SCOPE }),
});
const dev = (await start.json()) as { device_code?: string; user_code?: string; verification_url?: string; expires_in?: number; interval?: number; error?: string; error_description?: string };
if (!start.ok || !dev.device_code) {
  console.error(`Échec : ${dev.error ?? start.status} ${dev.error_description ?? ''}`);
  console.error('Vérifiez que le client OAuth est de type « Téléviseurs et appareils à saisie limitée » et que l’API Google Drive est activée.');
  process.exit(1);
}

console.log('\n1. Ouvrez cette adresse (sur votre téléphone) :\n   ' + dev.verification_url);
console.log('2. Saisissez ce code :  ' + dev.user_code);
console.log('3. Connectez-vous avec le compte Google qui doit stocker les fichiers, puis autorisez.\n');
console.log('En attente de votre autorisation...');

let wait = (dev.interval ?? 5) * 1000;
const deadline = Date.now() + (dev.expires_in ?? 1800) * 1000;
while (Date.now() < deadline) {
  await sleep(wait);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: clientId, client_secret: clientSecret, device_code: dev.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
  });
  const t = (await res.json()) as { refresh_token?: string; error?: string };
  if (t.refresh_token) {
    console.log('\nAutorisation réussie. Ajoutez cette variable dans l\'environnement du serveur (Render), sans la partager :\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${t.refresh_token}\n`);
    process.exit(0);
  }
  if (t.error === 'authorization_pending') continue;
  if (t.error === 'slow_down') { wait += 5000; continue; }
  console.error(`Arrêt : ${t.error ?? res.status}${t.error === 'access_denied' ? ' (autorisation refusée)' : ''}`);
  process.exit(1);
}
console.error('Délai dépassé : relancez la commande.');
process.exit(1);
