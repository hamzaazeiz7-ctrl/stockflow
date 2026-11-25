# StockFlow — Gestion de stock au CUMP

Application web locale (PC, tablette, téléphone) : articles, entrées / sorties / inventaires, CUMP automatique,
alertes à seuils manuels, états et exports **Excel, Word, PDF**, synchronisation chiffrée via GitHub.
Aucun serveur : tout tourne dans le navigateur.

---

## ✅ À NE PAS OUBLIER (pense-bête)

- [ ] Créer le dépôt **du code** (`stockflow`) et y pousser ce dossier
- [ ] Activer **GitHub Pages** sur ce dépôt
- [ ] Créer le dépôt **de données**, **privé** (`stockflow-data`), **avec un fichier README** (dépôt non vide)
- [ ] Créer un **jeton** limité à `stockflow-data` (Contents : lecture et écriture)
- [ ] Choisir une **phrase secrète** et la noter dans un endroit sûr (impossible à récupérer si perdue)
- [ ] Configurer la synchro sur **chaque appareil** (même propriétaire, dépôt, jeton, phrase secrète)
- [ ] Faire une **sauvegarde JSON** de temps en temps (Paramètres → Données)
- [ ] À chaque mise à jour de l'app : changer `VERSION` dans `sw.js` avant de pousser

---

## 1. Publier l'application (dépôt du code)

Le code ne contient **aucune donnée** : il peut être dans un dépôt public (GitHub Pages gratuit).

```bash
cd stockflow            # le dossier de ce README
git init
git add .
git commit -m "StockFlow v2"
git branch -M main
git remote add origin https://github.com/<votre-compte>/stockflow.git
git push -u origin main
```

Puis sur GitHub : **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save**.
L'application est disponible après une minute sur `https://<votre-compte>.github.io/stockflow/`.

## 2. Créer le dépôt de données (privé)

1. GitHub → **New repository** → nom `stockflow-data` → **Private** → cocher **Add a README file** → Create.
   (Le dépôt ne doit pas être vide, sinon l'enregistrement du premier fichier échoue.)
2. Aucun autre réglage : l'application y crée un fichier `stockflow-data.json` **chiffré** (AES-256-GCM, clé dérivée
   de votre phrase secrète). Même avec l'accès au dépôt, personne ne peut lire les données sans la phrase secrète.

## 3. Créer le jeton d'accès

GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token** :

- **Repository access** : *Only select repositories* → `stockflow-data` uniquement
- **Permissions → Repository permissions → Contents** : *Read and write*
- Durée : au choix (prévoir un rappel pour le renouveler)

Copiez le jeton (`github_pat_…`) : il n'est affiché qu'une fois.

## 4. Configurer chaque appareil

Ouvrir l'application → **Paramètres → Synchronisation GitHub** :

| Champ | Valeur |
|---|---|
| Propriétaire GitHub | votre compte (ou organisation) |
| Dépôt de données | `stockflow-data` |
| Branche | laisser vide (branche par défaut) |
| Fichier | `stockflow-data.json` |
| Jeton | le jeton créé à l'étape 3 |
| Phrase secrète | **la même sur tous les appareils** |

Cliquer **Tester la connexion** (doit afficher « privé ✔ » et « écriture autorisée ✔ »), puis **Enregistrer**.

- 1er appareil (celui qui a les données) : elles sont envoyées.
- Autres appareils (vides) : ils récupèrent automatiquement les données.
- Ensuite, avec « Synchronisation automatique » : envoi ~4 s après chaque modification, récupération à l'ouverture
  de l'app et au retour au premier plan. Le nuage en haut indique l'état (✔ synchronisé, « À envoyer », erreur…).
- Si les données ont été modifiées des deux côtés, l'app demande laquelle conserver (une copie de sécurité de
  l'appareil est gardée avant tout remplacement).

> Conseil : évitez de saisir **en même temps** sur deux appareils sans réseau, puis de synchroniser plus tard.

## 5. Installer comme une application

- **Android (Chrome)** : menu ⋮ → *Installer l'application*.
- **iPhone / iPad (Safari)** : Partager → *Sur l'écran d'accueil*.
- **PC (Chrome / Edge)** : icône « Installer » dans la barre d'adresse.

Une fois ouverte une première fois, l'application fonctionne **hors ligne** ; la synchro reprend au retour du réseau.

## 6. Fonctions principales

- **Articles** : code, désignation, famille, unité, code-barres, emplacement, fournisseur, stock initial, archivage.
- **Entrées / Sorties / Inventaires** : CUMP recalculé, aperçu avant validation, blocage (ou alerte) si le stock
  devient négatif, y compris lors d'une modification ou suppression d'un ancien mouvement.
- **Alertes & seuils** : minimum, point de commande, maximum, quantité de réapprovisionnement **réglables à la main**
  (article par article ou en masse), alerte « sans mouvement ».
- **États & exports** : stock à date, sur période, fiche article, journal, réapprovisionnement, ABC, valorisation par
  famille, alertes — en **Excel** (vrais nombres + formules de total), **Word** et **PDF** ; plus un **dossier complet
  avec sommaire**. Le nom de la société (Paramètres) figure en en-tête.
- **Affichage** : boutons **A− / A+** (ou Paramètres) pour ajuster la taille sur chaque appareil, thème clair / sombre.

## 7. Mettre à jour l'application

Modifier les fichiers, changer `VERSION` dans `sw.js` (ex. `stockflow-v2.0.1`), puis :

```bash
git add . && git commit -m "Mise à jour" && git push
```

## 8. Structure du dossier

```
index.html · manifest.webmanifest · sw.js
css/styles.css
js/core.js (calculs) · js/sync.js (GitHub) · js/exports.js · js/app.js (interface)
vendor/  (bibliothèques d'export, embarquées pour fonctionner hors ligne)
icons/
```

## Licences des composants embarqués

SheetJS (Apache-2.0), docx (MIT), jsPDF et jsPDF-AutoTable (MIT), police TeX Gyre Pagella pour les PDF
(GUST Font License, équivalent libre de Book Antiqua/Palatino).
