# Antso Video (version vola)

## Andramana eo an-toerana
npm install
ADMIN_KEY=zavatra-miafina npm start
Sokafy http://localhost:3000  (ny kaody WhatsApp dia hipoitra ao amin'ny terminal raha mbola tsy voasoratra ny Twilio)
Pejy admin (fankatoavana depot/retrait): http://localhost:3000/admin.html

## Variables d'environnement
ADMIN_KEY        teny miafina ho an'ny admin (ilaina)
RATE_PER_MIN     1000 (default)
DB_PATH          lalana ny rakitra base de données (ohatra /data/antso.db amin'ny Render Disk)
TWILIO_SID, TWILIO_TOKEN, TWILIO_WA_FROM   ho an'ny kaody WhatsApp tena izy

## Alefa amin'ny internet
Render.com > New Web Service. Build: npm install. Start: npm start.
Ilaina ny "Disk" maharitra (paid plan) satria miala ny rakitra tahirizina amin'ny plan maimaim-poana.
Ao amin'ny public/index.html, ovay ny SHOP_NUMBER ho laharanao Mobile Money.
