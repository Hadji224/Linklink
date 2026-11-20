import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SCREENS = path.join(import.meta.dirname, 'screens');
fs.mkdirSync(SCREENS, { recursive: true });
const PW = 'motdepasse123';

const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1280, height: 800 } };

async function signup(page: Page, name: string, email: string, code?: string) {
  await page.goto('/');
  if (code) await page.getByRole('button', { name: /code d'invitation/ }).click();
  await page.getByLabel('Nom complet').fill(name);
  await page.getByLabel('Adresse e-mail').fill(email);
  await page.getByLabel('Mot de passe').fill(PW);
  if (code) await page.getByLabel("Code d'invitation").fill(code);
  await page.getByLabel(/J'ai lu et j'accepte/).check();
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await expect(page.getByRole('heading', { name: /^(Bonjour|Bonsoir)/ })).toBeVisible();
}

const go = async (page: Page, hash: string) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
};

/** Appel d'API avec la session de la page (le jeton est dans le stockage local). */
const apiCall = (page: Page, method: string, url: string, body?: unknown) =>
  page.evaluate(async ({ method, url, body }) => {
    const r = await fetch(`/api${url}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('linklink_token')}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, { method, url, body });

let browser: Browser;
let ctxA: BrowserContext, ctxB: BrowserContext, ctxC: BrowserContext;
let admin: Page, founder: Page, guest: Page;
let memberCode = '', guestCode = '';
const errors: string[] = [];
const watch = (p: Page, who: string) => {
  p.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/status of (40[0-9]|415)/.test(m.text())) errors.push(`[${who}] ${m.text()}`);
  });
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser: b }) => {
  browser = b;
  ctxA = await browser.newContext({ ...desktop, locale: 'fr-FR', acceptDownloads: true });
  ctxB = await browser.newContext({ ...desktop, locale: 'fr-FR', acceptDownloads: true });
  ctxC = await browser.newContext({ ...phone, locale: 'fr-FR' });
  admin = await ctxA.newPage();
  founder = await ctxB.newPage();
  guest = await ctxC.newPage();
  watch(admin, 'admin'); watch(founder, 'fondateur'); watch(guest, 'invité');
});
test.afterAll(async () => {
  await ctxA.close(); await ctxB.close(); await ctxC.close();
  expect(errors, 'erreurs navigateur').toEqual([]);
});

test('connexion : premier compte = Administrateur technique (et PDG de démarrage), consentement obligatoire', async () => {
  await admin.goto('/');
  await expect(admin.getByRole('heading', { name: 'Créer le compte Administrateur technique' })).toBeVisible();
  await admin.screenshot({ path: path.join(SCREENS, '01-login-desktop.png') });
  await admin.getByLabel('Nom complet').fill('Awa Camara');
  await admin.getByLabel('Adresse e-mail').fill('awa@linklink.test');
  await admin.getByLabel('Mot de passe').fill(PW);
  await expect(admin.getByRole('button', { name: 'Créer mon compte' })).toBeDisabled(); // pas de consentement
  await admin.getByLabel(/J'ai lu et j'accepte/).check();
  await admin.getByRole('button', { name: 'Créer mon compte' }).click();
  await expect(admin.getByRole('heading', { name: /^(Bonjour|Bonsoir) Awa/ })).toBeVisible();
  await admin.screenshot({ path: path.join(SCREENS, '02-accueil-desktop.png') });
});

test("équipe : codes d'invitation, inscription fondateur et invité", async () => {
  await go(admin, 'equipe');
  const codes = admin.locator('code');
  await expect(codes).toHaveCount(2);
  memberCode = (await codes.nth(0).innerText()).trim();
  guestCode = (await codes.nth(1).innerText()).trim();
  expect(memberCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  await founder.goto('/');
  await founder.getByRole('button', { name: /code d'invitation/ }).click();
  await founder.getByLabel('Nom complet').fill('Moussa Bah');
  await founder.getByLabel('Adresse e-mail').fill('moussa@linklink.test');
  await founder.getByLabel('Mot de passe').fill(PW);
  await founder.getByLabel("Code d'invitation").fill('FAUX-FAUX');
  await founder.getByLabel(/J'ai lu et j'accepte/).check();
  await founder.getByRole('button', { name: 'Créer mon compte' }).click();
  await expect(founder.getByText("Code d'invitation incorrect.")).toBeVisible();
  await founder.getByLabel("Code d'invitation").fill(memberCode);
  await founder.getByRole('button', { name: 'Créer mon compte' }).click();
  await expect(founder.getByRole('heading', { name: /^(Bonjour|Bonsoir) Moussa/ })).toBeVisible();

  await signup(guest, 'Ibrahima Soumah', 'ibrahima@linklink.test', guestCode);
  await go(guest, 'equipe');
  await expect(guest.getByText('Awa Camara').first()).toBeVisible();
  expect(await guest.locator('code').count()).toBe(0); // un invité ne voit aucun code

  await go(founder, 'equipe');
  await expect(founder.locator('code')).toHaveCount(1); // le fondateur voit seulement le code fondateur
  await expect(admin.getByText('Ibrahima Soumah').first()).toBeVisible(); // temps réel : l'équipe se met à jour
  await expect(admin.getByLabel('Rôle de Ibrahima Soumah')).toHaveValue('guest');

  // v1.2 : le PDG (ici l'administrateur technique, PDG de démarrage) attribue les fonctions de Moussa.
  const members = (await apiCall(admin, 'GET', '/members')).data.members as { id: string; name: string }[];
  const moussa = members.find((m) => m.name === 'Moussa Bah')!;
  expect((await apiCall(admin, 'POST', '/functions', { userId: moussa.id, fn: 'project_lead' })).status).toBe(201);
  expect((await apiCall(admin, 'POST', '/functions', { userId: moussa.id, fn: 'coordinator' })).status).toBe(201);
});

test('projet : création, tâche, Kanban, sous-tâches, commentaire avec mention', async () => {
  await founder.reload(); // prend en compte les fonctions attribuées par le PDG
  await go(founder, 'projets');
  await founder.getByRole('button', { name: 'Nouveau projet' }).click();
  await founder.getByLabel('Nom du projet').fill('Application mobile');
  await founder.getByLabel('Description').fill('Application Android et API');
  await founder.getByLabel('Responsable du projet').selectOption({ label: 'Moussa Bah' });
  await founder.getByRole('button', { name: 'Créer le projet' }).click();
  await expect(founder.getByRole('heading', { name: 'Application mobile', level: 1 })).toBeVisible();
  await founder.screenshot({ path: path.join(SCREENS, '03-projet-apercu.png') });

  // Ajout de l'invité au projet
  await founder.getByRole('tab', { name: 'Membres' }).click();
  await founder.getByLabel('Ajouter un membre').selectOption({ label: 'Ibrahima Soumah' });
  await founder.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await expect(founder.getByText('Ibrahima Soumah').first()).toBeVisible();

  await founder.getByRole('tab', { name: 'Tâches' }).click();
  await founder.getByRole('button', { name: 'Nouvelle tâche' }).click();
  await founder.getByLabel('Titre').fill('Corriger le bug de connexion');
  await founder.getByLabel('Assignée à').selectOption({ label: 'Ibrahima Soumah' });
  await founder.getByLabel('Priorité').selectOption('urgent');
  await founder.getByLabel('Échéance').fill(new Date().toISOString().slice(0, 10));
  await founder.getByPlaceholder('Ajouter une étape').fill('Écrire les tests');
  await founder.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await founder.getByRole('button', { name: 'Créer la tâche' }).click();
  await expect(founder.getByRole('dialog', { name: 'Corriger le bug de connexion' })).toBeVisible();
  await expect(founder.getByText('Votre rôle : Responsable / PDG')).toBeVisible(); // le chef de projet a tous les droits sur ses tâches

  // Sous-tâche cochée + commentaire avec mention
  await founder.getByRole('checkbox', { name: 'Écrire les tests' }).check();
  await founder.getByLabel('Votre commentaire').fill('Merci @Ibrahima');
  await founder.getByRole('listbox', { name: 'Mentionner' }).getByRole('option', { name: /Ibrahima Soumah/ }).click();
  await founder.getByRole('button', { name: 'Commenter' }).click();
  await expect(founder.getByText('Merci @Ibrahima Soumah')).toBeVisible();
  await founder.screenshot({ path: path.join(SCREENS, '04-tache-detail.png') });
  await founder.keyboard.press('Escape');

  // Kanban : déplacement en « En cours »
  const card = founder.locator('article', { hasText: 'Corriger le bug de connexion' });
  await card.getByRole('button', { name: 'Déplacer vers En cours' }).click();
  await expect(founder.getByRole('region', { name: /^En cours \(1\)/ })).toBeVisible();
  await founder.screenshot({ path: path.join(SCREENS, '05-kanban.png') });

  // L'invité (téléphone) voit le projet, la notification d'assignation, et la tâche dans « Ma journée »
  await go(guest, 'notifications');
  await expect(guest.getByRole('button', { name: /Moussa Bah vous a assigné une tâche/ })).toBeVisible();
  await expect(guest.getByRole('button', { name: /Moussa Bah vous a mentionné/ })).toBeVisible();
  await guest.screenshot({ path: path.join(SCREENS, '06-notifications-mobile.png') });
  await go(guest, 'accueil');
  await expect(guest.getByText('Corriger le bug de connexion')).toBeVisible();
  await guest.screenshot({ path: path.join(SCREENS, '07-accueil-mobile.png') });
  await go(guest, 'projets');
  await expect(guest.getByRole('link', { name: /Application mobile/ })).toBeVisible();
});

test("tâche : l'interface suit le rôle (assigné, observateur, responsable) — amendement v1.1", async () => {
  // Assigné (l'invité, sur téléphone) : statut modifiable, tout le reste grisé.
  await go(guest, 'taches');
  await guest.getByRole('button', { name: /Corriger le bug de connexion/ }).first().click();
  const g = guest.getByRole('dialog', { name: 'Corriger le bug de connexion' });
  await expect(g).toBeVisible();
  await expect(g.getByText('Votre rôle : Assigné')).toBeVisible();
  await expect(g.getByLabel('Titre')).toBeDisabled();
  await expect(g.getByLabel('Priorité')).toBeDisabled();
  await expect(g.getByLabel('Assignée à')).toBeDisabled();
  await expect(g.getByRole('button', { name: 'Enregistrer' })).toHaveCount(0);
  const steps = g.getByRole('group', { name: 'Statut de la tâche' });
  await steps.getByRole('button', { name: 'En révision' }).click();
  await expect(steps.getByRole('button', { name: /✓ En révision/ })).toBeVisible();
  await g.getByLabel('Votre commentaire').fill('Correctif envoyé, à vérifier.');
  await g.getByRole('button', { name: 'Commenter' }).click();
  await expect(g.getByText('Correctif envoyé, à vérifier.')).toBeVisible();
  await expect(g.getByText(/Ibrahima Soumah a changé le statut de « En cours » à « En révision »/)).toBeVisible(); // historique
  await guest.screenshot({ path: path.join(SCREENS, '04b-tache-assigne-mobile.png') });
  await guest.keyboard.press('Escape');

  // Le créateur est prévenu du changement de statut.
  await go(founder, 'notifications');
  await expect(founder.getByRole('button', { name: /Ibrahima Soumah a passé « Corriger le bug de connexion » à « En révision »/ })).toBeVisible();

  // Le Administrateur technique crée une tâche dans le projet : le fondateur n'en est qu'observateur.
  await go(admin, 'taches');
  await admin.getByRole('button', { name: 'Nouvelle tâche' }).click();
  const nt = admin.getByRole('dialog', { name: 'Nouvelle tâche' });
  await nt.getByLabel('Projet').selectOption({ label: 'Application mobile' });
  await nt.getByLabel('Titre').fill('Valider le budget');
  await nt.getByRole('button', { name: 'Créer la tâche' }).click();
  const a = admin.getByRole('dialog', { name: 'Valider le budget' });
  await expect(a.getByText('Votre rôle : Responsable / PDG')).toBeVisible();
  await expect(a.getByLabel('Titre')).toBeEnabled();
  await admin.keyboard.press('Escape');

  // Le fondateur est ici chef de projet (tous les droits) : le statut d'observateur se vérifie avec l'invité, membre du projet.
  await go(guest, 'taches');
  await guest.getByRole('button', { name: /Valider le budget/ }).first().click();
  const o = guest.getByRole('dialog', { name: 'Valider le budget' });
  await expect(o.getByText('👁️ Lecture seule')).toBeVisible();
  await expect(o.getByLabel('Titre')).toBeDisabled();
  await expect(o.getByRole('button', { name: 'Enregistrer' })).toHaveCount(0);
  await expect(o.getByRole('group', { name: 'Statut de la tâche' }).getByRole('button', { name: 'En cours' })).toBeDisabled();
  await expect(o.getByRole('button', { name: 'Actions sur la tâche' })).toHaveCount(0); // ni archivage, ni suppression
  await o.getByLabel('Votre commentaire').fill('Je valide côté finances.');
  await o.getByRole('button', { name: 'Commenter' }).click(); // les observateurs peuvent toujours commenter
  await expect(o.getByText('Je valide côté finances.')).toBeVisible();
  await guest.screenshot({ path: path.join(SCREENS, '04c-tache-observateur-mobile.png') });
  await guest.keyboard.press('Escape');
});

test('invité : ne peut pas créer de projet ni de rendez-vous, ne voit pas ceux des autres', async () => {
  await go(guest, 'projets');
  await expect(guest.getByRole('button', { name: 'Nouveau projet' })).toHaveCount(0);
  await go(admin, 'projets');
  await admin.getByRole('button', { name: 'Nouveau projet' }).click();
  await admin.getByLabel('Nom du projet').fill('Stratégie interne');
  await admin.getByRole('button', { name: 'Créer le projet' }).click();
  await expect(admin.getByRole('heading', { name: 'Stratégie interne', level: 1 })).toBeVisible();
  await go(guest, 'projets');
  await expect(guest.getByRole('link', { name: /Stratégie interne/ })).toHaveCount(0);
  await go(guest, 'rendez-vous');
  await expect(guest.getByRole('button', { name: 'Nouveau' })).toHaveCount(0);
});

test('messages : temps réel, non lus, DM privé, #annonces verrouillé, mention', async () => {
  await go(founder, 'accueil'); // le fondateur n'est pas sur l'écran Messages
  await go(admin, 'messages');
  const box = admin.getByLabel('Votre message').locator('visible=true');
  await box.fill('Bonjour à tous ! https://linklink.example/doc');
  await admin.getByRole('button', { name: 'Envoyer' }).locator('visible=true').click();
  await founder.waitForFunction(() => document.title.startsWith('(1)'));
  await go(founder, 'messages');
  await expect(founder.getByText('Bonjour à tous !').first()).toBeVisible();
  const link = founder.getByRole('link', { name: 'https://linklink.example/doc' });
  expect(await link.getAttribute('rel')).toBe('noopener noreferrer');
  await founder.waitForFunction(() => document.title === 'LinkLink'); // salon ouvert = lu

  // #annonces : lecture seule pour un fondateur, écriture pour le Administrateur technique
  await founder.getByRole('button', { name: '# annonces' }).click();
  await expect(founder.getByText('Salon réservé aux annonces')).toBeVisible();

  // Message direct admin → fondateur : privé, avec badge non lu
  await go(admin, 'equipe');
  await admin.getByRole('button', { name: 'Écrire à Moussa Bah' }).click();
  await expect(admin.getByRole('heading', { name: 'Moussa Bah' })).toBeVisible();
  await admin.getByLabel('Votre message').locator('visible=true').fill('Message privé pour Moussa');
  await admin.getByRole('button', { name: 'Envoyer' }).locator('visible=true').click();
  await founder.getByRole('button', { name: /Awa Camara/ }).filter({ hasText: '1' }).waitFor();
  await founder.getByRole('button', { name: /Awa Camara/ }).click();
  await expect(founder.getByText('Message privé pour Moussa')).toBeVisible();
  // L'invité n'a aucune trace de cette conversation
  await go(guest, 'messages');
  await expect(guest.getByText('Message privé pour Moussa')).toHaveCount(0);
  await expect(guest.getByRole('button', { name: /Awa Camara/ })).toHaveCount(0);
  await founder.screenshot({ path: path.join(SCREENS, '08-messages-desktop.png') });
  await guest.screenshot({ path: path.join(SCREENS, '09-messages-mobile.png') });
});

test('reconnexion : coupure du temps réel, indicateur, rattrapage des messages manqués', async () => {
  // On s'interpose sur le WebSocket du fondateur pour simuler une perte de réseau (le mode « hors ligne » de Chromium ne coupe pas les sockets ouverts).
  let blocked = false;
  const live: { close: () => void }[] = [];
  await founder.routeWebSocket(/\/ws/, (ws) => {
    if (blocked) { ws.close(); return; }
    ws.connectToServer();
    live.push(ws);
  });
  await founder.reload();
  await go(founder, 'messages');
  await founder.getByRole('button', { name: /Awa Camara/ }).click();
  await expect(founder.getByText('Message privé pour Moussa')).toBeVisible();
  await expect(founder.getByText('● En ligne')).toBeVisible();

  blocked = true;
  live.forEach((ws) => ws.close());
  await expect(founder.getByText('○ Reconnexion…')).toBeVisible();

  // Pendant la coupure, le Administrateur technique écrit : le fondateur ne peut pas le recevoir en direct.
  await admin.getByLabel('Votre message').locator('visible=true').fill('Écrit pendant la coupure');
  await admin.getByRole('button', { name: 'Envoyer' }).locator('visible=true').click();
  await expect(founder.getByText('Écrit pendant la coupure')).toHaveCount(0);

  blocked = false; // le réseau revient : reconnexion automatique, puis rechargement des données
  await expect(founder.getByText('● En ligne')).toBeVisible({ timeout: 30_000 });
  await expect(founder.getByText('Écrit pendant la coupure')).toBeVisible();
});

test('documents : dépôt avec niveau, recherche, téléchargement, confidentialité', async () => {
  fs.writeFileSync('/tmp/specification.pdf', '%PDF-1.4 test');
  fs.writeFileSync('/tmp/strategie.pdf', '%PDF-1.4 secret');
  await go(founder, 'documents');
  await founder.getByRole('button', { name: /Général/ }).first().click();
  await founder.getByRole('button', { name: 'Déposer' }).click();
  await founder.getByLabel('Choisir des fichiers').setInputFiles('/tmp/specification.pdf');
  await founder.getByLabel('Niveau de confidentialité').selectOption('internal');
  await founder.getByRole('button', { name: /^Déposer 1/ }).click();
  await expect(founder.getByText('specification.pdf').first()).toBeVisible();

  await founder.getByRole('button', { name: 'Déposer' }).click();
  await founder.getByLabel('Choisir des fichiers').setInputFiles('/tmp/strategie.pdf');
  await founder.getByLabel('Niveau de confidentialité').selectOption('strict');
  await founder.getByRole('button', { name: /^Déposer 1/ }).click();
  await expect(founder.getByText('strategie.pdf').first()).toBeVisible();
  await founder.screenshot({ path: path.join(SCREENS, '10-documents-desktop.png') });

  // Le Administrateur technique voit les deux, peut rechercher et télécharger
  await go(admin, 'documents');
  await admin.getByLabel('Rechercher un fichier').fill('specif');
  await expect(admin.getByText('specification.pdf').first()).toBeVisible();
  const dl = admin.waitForEvent('download');
  await admin.getByRole('button', { name: 'Télécharger specification.pdf' }).click();
  expect(fs.readFileSync(await (await dl).path(), 'utf8')).toBe('%PDF-1.4 test');
  await admin.getByLabel('Rechercher un fichier').fill('strategie');
  await expect(admin.getByText('strategie.pdf').first()).toBeVisible();

  // L'invité ne voit aucun des deux fichiers
  await go(guest, 'documents');
  await guest.getByLabel('Rechercher un fichier').fill('pdf');
  await expect(guest.getByText('Aucun fichier ne correspond.')).toBeVisible();

  // Fichier refusé (format non autorisé)
  fs.writeFileSync('/tmp/virus.exe', 'MZ');
  await go(founder, 'documents');
  await founder.getByLabel('Rechercher un fichier').fill('');
  await founder.getByRole('button', { name: 'Déposer' }).click();
  await founder.getByLabel('Choisir des fichiers').setInputFiles('/tmp/virus.exe');
  await founder.getByRole('button', { name: /^Déposer 1/ }).click();
  await expect(founder.getByText(/pas accepté/)).toBeVisible();
  await founder.keyboard.press('Escape');
});

test('rendez-vous : création, RSVP en direct, export .ics', async () => {
  await go(founder, 'rendez-vous');
  await founder.getByRole('button', { name: 'Nouveau' }).click();
  await founder.getByLabel('Titre').fill('Point hebdomadaire');
  await founder.getByLabel(/Lieu ou lien/).fill('https://meet.example/linklink');
  await founder.getByRole('button', { name: 'Créer le rendez-vous' }).click();
  await expect(founder.getByRole('heading', { name: 'Point hebdomadaire' })).toBeVisible();
  await go(admin, 'rendez-vous');
  await expect(admin.getByRole('heading', { name: 'Point hebdomadaire' })).toBeVisible();
  await admin.getByRole('button', { name: 'Peut-être' }).click();
  await expect(founder.getByText('Awa Camara · peut-être')).toBeVisible();
  const dl = founder.waitForEvent('download');
  await founder.getByRole('button', { name: '+ Agenda' }).click();
  const ics = fs.readFileSync(await (await dl).path(), 'utf8');
  expect(ics).toContain('BEGIN:VEVENT');
  expect(ics).toContain('SUMMARY:Point hebdomadaire');
  // L'invité (non membre d'un projet concerné) ne voit pas ce rendez-vous d'équipe
  await go(guest, 'rendez-vous');
  await expect(guest.getByText('Point hebdomadaire')).toHaveCount(0);
  await admin.screenshot({ path: path.join(SCREENS, '11-rendezvous.png') });
});

test('profil, RGPD, journal, pages légales', async () => {
  await go(founder, 'profil');
  await expect(founder.getByRole('heading', { name: 'Mes données (RGPD)' })).toBeVisible();
  const dl = founder.waitForEvent('download');
  await founder.getByRole('button', { name: 'Exporter mes données' }).click();
  const data = JSON.parse(fs.readFileSync(await (await dl).path(), 'utf8'));
  expect(data.profil.email).toBe('moussa@linklink.test');
  await founder.screenshot({ path: path.join(SCREENS, '12-profil.png') });

  await go(admin, 'journal');
  await expect(admin.getByText(/Projet « Application mobile » créé/)).toBeVisible();
  await admin.screenshot({ path: path.join(SCREENS, '13-journal.png') });
  // Un fondateur sans fonction de contrôle ne voit que le journal d'urgence (transparence) : ni activité, ni décisions métier, ni sécurité.
  await go(founder, 'journal');
  await expect(founder.getByRole('tab', { name: 'Urgence' })).toBeVisible();
  await expect(founder.getByRole('tab', { name: 'Activité' })).toHaveCount(0);
  await expect(founder.getByRole('tab', { name: 'Décisions métier' })).toHaveCount(0);
  await go(guest, 'journal'); // route réservée : retombe sur l'accueil
  await expect(guest.getByRole('heading', { name: /^(Bonjour|Bonsoir)/ })).toBeVisible();

  await go(guest, 'legal/confidentialite');
  await expect(guest.getByRole('heading', { name: 'Politique de confidentialité' })).toBeVisible();
  await go(guest, 'accueil');
});

test('archivage en deux temps : le responsable déclare, le PDG confirme, puis lecture seule', async () => {
  await go(founder, 'projets');
  await founder.getByRole('link', { name: /Application mobile/ }).click();
  await expect(founder.getByRole('button', { name: 'Confirmer l\'archivage' })).toHaveCount(0); // le chef de projet ne confirme pas lui-même
  await founder.getByRole('button', { name: 'Déclarer le projet terminé' }).click();
  const dlg = founder.getByRole('dialog', { name: 'Déclarer le projet terminé' });
  for (const f of await dlg.getByLabel(/pourquoi reste-t-elle ouverte/).all()) await f.fill('Reportée à la prochaine version');
  await dlg.getByRole('button', { name: 'Déclarer terminé' }).click();
  await expect(founder.getByText(/en attente de la confirmation d'archivage par le PDG/)).toBeVisible();

  // Le PDG (administrateur technique de démarrage) confirme.
  await go(admin, 'projets');
  await admin.getByRole('link', { name: /Application mobile/ }).click();
  await admin.getByRole('button', { name: "Confirmer l'archivage" }).click();
  await admin.getByRole('button', { name: 'Archiver', exact: true }).click();
  await expect(admin.getByText(/archivé/i).first()).toBeVisible();
  await expect(founder.getByText('Projet archivé : consultable, mais non modifiable.')).toBeVisible(); // temps réel
  await founder.getByRole('tab', { name: 'Tâches' }).click();
  await expect(founder.getByRole('button', { name: 'Nouvelle tâche' })).toHaveCount(0);
});

test('v1.2 : demande de dépense, validation par le PDG, gouvernance et communications', async () => {
  // Le fondateur demande une dépense ; le PDG la voit dans ses validations et l'approuve ; le journal métier la retrace.
  await go(founder, 'finances');
  await founder.getByRole('button', { name: 'Nouvelle demande' }).click();
  const f = founder.getByRole('dialog', { name: 'Nouvelle demande de dépense' });
  await f.getByRole('textbox', { name: 'Bénéficiaire' }).fill('Hébergeur cloud');
  await f.getByLabel('Montant').fill('150000');
  await f.getByLabel('Motif').fill('Abonnement serveur du mois');
  await f.getByRole('button', { name: 'Soumettre la demande' }).click();
  await expect(founder.getByText('Hébergeur cloud').first()).toBeVisible();

  await go(admin, 'gouvernance');
  await expect(admin.getByRole('heading', { name: 'Gouvernance' })).toBeVisible();
  await expect(admin.getByText(/Hébergeur cloud/).first()).toBeVisible({ timeout: 15_000 });
  const pend = (await apiCall(admin, 'GET', '/expenses')).data.expenses as { id: string; beneficiary: string; status: string }[];
  const exp = pend.find((e) => e.beneficiary === 'Hébergeur cloud')!;
  expect(exp.status).toBe('pending');
  expect((await apiCall(admin, 'POST', `/expenses/${exp.id}/decision`, { decision: 'approve' })).status).toBe(200);
  await admin.screenshot({ path: path.join(SCREENS, '14-gouvernance.png') });

  // Séparation des pouvoirs : le fondateur (sans fonction de Caissier) ne peut pas déclarer de paiement.
  expect((await apiCall(founder, 'POST', `/expenses/${exp.id}/payments`, { amount: 150000 })).status).toBe(403);
  await go(founder, 'communications');
  await expect(founder.getByRole('heading', { name: 'Communications' })).toBeVisible();
  await go(founder, 'accueil');
});

test('accessibilité WCAG AA (axe) sur les écrans principaux', async () => {
  const all: string[] = [];
  for (const [page, name, routes] of [
    [admin, 'bureau', ['accueil', 'projets', 'taches', 'messages', 'rendez-vous', 'documents', 'equipe', 'notifications', 'profil', 'journal', 'finances', 'communications', 'gouvernance']],
    [guest, 'mobile', ['accueil', 'projets', 'taches', 'messages', 'rendez-vous', 'equipe', 'documents', 'notifications', 'profil']],
  ] as [Page, string, string[]][]) {
    for (const r of routes) {
      await go(page, r);
      await page.waitForTimeout(400);
      await expect(page.locator('[aria-live=polite] [role=status]')).toHaveCount(0, { timeout: 15_000 }); // une notification en cours d'animation fausse la mesure de contraste
      const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      if (name === 'mobile') {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 0) all.push(`${name}/${r}: débordement horizontal de ${overflow}px`);
      }
      for (const v of res.violations) all.push(`${name}/${r}: ${v.id} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
    }
  }
  expect(all, 'violations WCAG AA').toEqual([]);
});

test('ordinateur portable : le menu latéral reste entièrement accessible quand la fenêtre est peu haute', async () => {
  await go(admin, 'accueil');
  for (const [w, h] of [[1366, 600], [1280, 500], [1024, 600]] as const) {
    await admin.setViewportSize({ width: w, height: h });
    const aside = admin.locator('aside.side');
    // Profil (donc déconnexion), Journaux et état de connexion : visibles, ou atteignables en faisant défiler le menu.
    for (const target of [aside.locator('a[href$="#journal"]'), aside.locator('a[href$="#profil"]'), aside.getByRole('status')]) {
      await target.scrollIntoViewIfNeeded();
      await expect(target, `visible à ${w}x${h}`).toBeInViewport();
    }
    await aside.evaluate((e) => { e.scrollTop = 0; });
  }
  await admin.setViewportSize(desktop.viewport);
});

test('pièces jointes : image dans la bulle avec icône de téléchargement, copie gardée sur l’appareil, « expirée » ailleurs', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const expired = (r: import('@playwright/test').Route) => r.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ error: 'Ce fichier a expiré sur le serveur.' }) });
  await go(admin, 'messages');
  await admin.getByRole('button', { name: '# général' }).click();
  await admin.getByLabel('Choisir un fichier').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });
  await expect(admin.getByRole('img', { name: 'photo.png' })).toBeVisible();
  await expect(admin.getByRole('button', { name: 'Télécharger photo.png' }).first()).toBeVisible(); // icône toujours visible, pas seulement au survol
  await expect.poll(() => admin.evaluate(async () => (await (await caches.open('ll-files-v1')).keys()).length)).toBeGreaterThan(0);
  await admin.screenshot({ path: path.join(SCREENS, '15-piece-jointe-image.png') });

  // Un autre appareil (sans copie locale) alors que le serveur a supprimé le fichier : message clair, pas d'erreur.
  const ctxD = await browser.newContext({ ...desktop, locale: 'fr-FR', storageState: await ctxA.storageState() });
  const other = await ctxD.newPage();
  await other.route('**/api/files/*/preview', expired);
  await other.goto('/#messages');
  await other.getByRole('button', { name: '# général' }).click();
  await expect(other.getByText('Photo expirée').first()).toBeVisible();
  await ctxD.close();

  // L'appareil qui l'avait déjà ouverte continue de l'afficher, même quand le serveur répond « expiré ».
  await admin.route('**/api/files/*/preview', expired);
  await admin.reload();
  await go(admin, 'messages');
  await admin.getByRole('button', { name: '# général' }).click();
  await expect(admin.getByRole('img', { name: 'photo.png' })).toBeVisible();
  await admin.unroute('**/api/files/*/preview');
});

test('grand écran : la molette défile même au-dessus des marges vides et le dernier bouton est atteignable', async () => {
  await admin.setViewportSize({ width: 1920, height: 600 });
  await go(admin, 'gouvernance');
  await admin.getByRole('tab', { name: 'Fonctions' }).click();
  const dernier = admin.getByRole('button', { name: 'Attribuer' }).last();
  await expect(dernier).toBeVisible();
  // Souris dans la marge vide à gauche du contenu (la page ne doit pas « ignorer » la molette).
  await admin.mouse.move(330, 300);
  await admin.mouse.wheel(0, 4000);
  await expect(dernier).toBeInViewport();
  await admin.setViewportSize(desktop.viewport);
});

test('déconnexion et session conservée au rechargement', async () => {
  await go(admin, 'accueil');
  await admin.reload();
  await expect(admin.getByRole('heading', { name: /^(Bonjour|Bonsoir)/ })).toBeVisible();
  await go(admin, 'profil');
  await admin.getByRole('button', { name: 'Se déconnecter' }).click();
  await admin.getByRole('button', { name: 'Se déconnecter' }).last().click();
  await expect(admin.getByRole('heading', { name: 'Connexion' })).toBeVisible();
});
