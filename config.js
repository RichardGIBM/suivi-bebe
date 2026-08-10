/* =========================================================
   Suivi Bébé — Configuration Supabase (Phase 3)
   ---------------------------------------------------------
   Ces 3 valeurs sont PUBLIQUES et sans risque :
   - `url` et `anon` sont la clé anonyme du projet (protégée par
     la RLS côté serveur : aucun accès aux données sans être connecté).
   - `email` est le compte "foyer" partagé ; la vraie barrière est
     son MOT DE PASSE (le code partagé que vous tapez à l'écran de
     déverrouillage), jamais stocké ici.

   👉 Remplace les 3 valeurs ci-dessous par celles de ton projet
      Supabase (Settings → API pour url/anon). Tant que `url` contient
      "XXXX", l'app reste 100 % locale (pas de synchro).
   ========================================================= */
window.SB_CONFIG = {
  url:   'https://hlsbxwqzaehfjiwccwkz.supabase.co',
  anon:  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhsc2J4d3F6YWVoZmppd2Njd2t6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNzYwMTAsImV4cCI6MjEwMTk1MjAxMH0.jWfhkJ9naGU3jpfHUUsod5QVtyozX1taBkW_60iwxgM',
  email: 'foyer@suivi-bebe.local',
};
